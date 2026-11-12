import {
  searchMessagesByDateRange,
  searchMessagesByKeyword,
  getRecentMessages,
  Message
} from '../db/memory.js';

export interface RetrievedContextResult {
  hasTemporalReference: boolean;
  detectedDates: string[]; // YYYY-MM-DD
  detectedKeywords: string[];
  matchedMessages: Message[];
  formattedContext: string;
}

const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
};

const DAY_OF_WEEK_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
};

// Known domain entity keywords for past conversation retrieval
const CANDIDATE_KEYWORDS = [
  'crm',
  'postgres',
  'postgresql',
  'supabase',
  'neon',
  'aws rds',
  'rds',
  'render',
  'railway',
  'hubspot',
  'pipedrive',
  'attio',
  'close',
  'folk',
  'next.js',
  'nextjs',
  'node.js',
  'nodejs',
  'lts',
  'claude',
  'sonnet',
  'pricing',
  'shortlist',
  'shortlisted',
  'hosting'
];

/**
 * Formats a Date object to YYYY-MM-DD string.
 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Extracts explicit dates (e.g. "3 November", "November 3", "2026-11-03") from text.
 */
function extractExplicitDates(text: string, now: Date): string[] {
  const dates: Set<string> = new Set();
  const lower = text.toLowerCase();

  // Pattern 1: ISO dates YYYY-MM-DD
  const isoRegex = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  let match: RegExpExecArray | null;
  while ((match = isoRegex.exec(text)) !== null) {
    dates.add(match[0]);
  }

  // Pattern 2: "3 November", "3rd of November", "3rd Nov"
  const dayMonthRegex = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/gi;
  while ((match = dayMonthRegex.exec(lower)) !== null) {
    const day = parseInt(match[1], 10);
    const monthStr = match[2].toLowerCase();
    const month = MONTH_MAP[monthStr];
    if (month !== undefined && day >= 1 && day <= 31) {
      const currentYear = now.getFullYear();
      const targetDateThisYear = new Date(currentYear, month, day);
      // If target date is in future relative to now, assume past year
      const year = targetDateThisYear > now ? currentYear - 1 : currentYear;
      const targetDate = new Date(year, month, day);
      dates.add(formatDate(targetDate));
    }
  }

  // Pattern 3: "November 3", "Nov 3rd"
  const monthDayRegex = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
  while ((match = monthDayRegex.exec(lower)) !== null) {
    const monthStr = match[1].toLowerCase();
    const day = parseInt(match[2], 10);
    const month = MONTH_MAP[monthStr];
    if (month !== undefined && day >= 1 && day <= 31) {
      const currentYear = now.getFullYear();
      const targetDateThisYear = new Date(currentYear, month, day);
      const year = targetDateThisYear > now ? currentYear - 1 : currentYear;
      const targetDate = new Date(year, month, day);
      dates.add(formatDate(targetDate));
    }
  }

  return Array.from(dates);
}

/**
 * Extracts relative day references (e.g. "Monday", "last Tuesday", "yesterday", "last week").
 */
function extractRelativeDates(text: string, now: Date): { dates: string[]; isWeekRange?: boolean } {
  const dates: Set<string> = new Set();
  const lower = text.toLowerCase();
  const currentDayOfWeek = now.getDay(); // 0 is Sun, 1 is Mon, ...

  // Yesterday
  if (/\byesterday\b/i.test(lower)) {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    dates.add(formatDate(yesterday));
  }

  // Day of week references (e.g. "on Monday", "last Tuesday", "this Monday", "Tuesday")
  const dayNames = Object.keys(DAY_OF_WEEK_MAP).join('|');
  const dayRegex = new RegExp(`\\b(last|previous|this)?\\s*(${dayNames})\\b`, 'gi');
  let match: RegExpExecArray | null;

  while ((match = dayRegex.exec(lower)) !== null) {
    const modifier = match[1]?.toLowerCase();
    const dayName = match[2].toLowerCase();
    const targetDayOfWeek = DAY_OF_WEEK_MAP[dayName];

    let diff = (currentDayOfWeek - targetDayOfWeek + 7) % 7;
    if (modifier === 'last' || modifier === 'previous') {
      diff = diff === 0 ? 7 : diff;
    } else {
      // General mention of weekday in past context ("On Monday we shortlisted...")
      diff = diff === 0 ? 7 : diff;
    }

    const resolvedDate = new Date(now);
    resolvedDate.setDate(now.getDate() - diff);
    dates.add(formatDate(resolvedDate));
  }

  // "last week"
  let isWeekRange = false;
  if (/\blast week\b/i.test(lower)) {
    isWeekRange = true;
    for (let i = 1; i <= 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      dates.add(formatDate(d));
    }
  }

  return { dates: Array.from(dates), isWeekRange };
}

/**
 * Extracts domain-relevant keywords from the query.
 */
function extractDomainKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];

  for (const kw of CANDIDATE_KEYWORDS) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(lower)) {
      found.push(kw);
    }
  }

  return found;
}

/**
 * Resolves temporal context and retrieves matching historical messages from SQLite.
 * Cross-session retrieval is automatically enabled when temporal or domain references are detected.
 */
export function resolveTemporalContext(
  userMessage: string,
  sessionId: string,
  now: Date = new Date()
): RetrievedContextResult {
  const explicitDates = extractExplicitDates(userMessage, now);
  const { dates: relativeDates } = extractRelativeDates(userMessage, now);

  const allDetectedDates = Array.from(new Set([...explicitDates, ...relativeDates]));
  const detectedKeywords = extractDomainKeywords(userMessage);

  const hasTemporalReference = allDetectedDates.length > 0 ||
    /\b(last|previous|yesterday|ago|since|earlier|before|shortlisted|asked you)\b/i.test(userMessage);

  const messageMap = new Map<number, Message>();

  // 1. Retrieve by detected dates (cross-session search)
  for (const dateStr of allDetectedDates) {
    const dateMessages = searchMessagesByDateRange(null, dateStr, dateStr);
    for (const msg of dateMessages) {
      messageMap.set(msg.id, msg);
    }
  }

  // 2. Retrieve by detected keywords (cross-session search)
  for (const kw of detectedKeywords) {
    const kwMessages = searchMessagesByKeyword(null, kw);
    for (const msg of kwMessages) {
      messageMap.set(msg.id, msg);
    }
  }

  // 3. If "what did i ask you" or conversational recall phrasing without specific match, pull recent across sessions
  if (messageMap.size === 0 && /\b(asked you|we shortlisted|we discussed|shortlisted)\b/i.test(userMessage)) {
    const recent = getRecentMessages(null, 6);
    for (const msg of recent) {
      messageMap.set(msg.id, msg);
    }
  }

  // Sort matched messages chronologically
  const matchedMessages = Array.from(messageMap.values()).sort((a, b) => {
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  // Format into a structured context block
  let formattedContext = '';
  if (matchedMessages.length > 0) {
    const lines: string[] = [
      '### [RETRIEVED PAST CONVERSATION MEMORY (CROSS-SESSION)] ###',
      'The following turns are retrieved from historical memory relevant to the user query:'
    ];

    for (const msg of matchedMessages) {
      // Format timestamp YYYY-MM-DD HH:mm
      const timeStr = msg.created_at.slice(0, 16).replace('T', ' ');
      lines.push(
        `\n[Session: ${msg.session_id} | Timestamp: ${timeStr} UTC | Date: ${msg.date_str} | Role: ${msg.role}]`
      );
      lines.push(msg.content);
    }

    lines.push('\n### [END OF RETRIEVED PAST CONVERSATION MEMORY] ###');
    formattedContext = lines.join('\n');
  }

  return {
    hasTemporalReference,
    detectedDates: allDetectedDates,
    detectedKeywords,
    matchedMessages,
    formattedContext
  };
}

