import {
  searchMessagesByDateRange,
  searchMessagesFTS,
  sanitizeFTSQuery,
  getRecentMessages,
  Message
} from '../db/memory.js';

export interface SearchWindow {
  startDate?: string; // YYYY-MM-DD
}

export interface RetrievedContextResult {
  hasTemporalReference: boolean;
  detectedDates: string[]; // YYYY-MM-DD
  detectedKeywords: string[]; // Deprecated: replaced by FTS5 query terms
  matchedMessages: Message[];
  formattedContext: string;
  searchWindow?: SearchWindow;
}

// Character budget for injected historical context (~1,000 tokens)
export const MAX_CONTEXT_CHARS = 4000;

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
 * Resolves temporal context and retrieves matching historical messages from SQLite.
 * Uses date-range filtering combined with SQLite FTS5 BM25 ranking over message content.
 * Caps the injected context to a character budget, prioritizing highest-ranked and most date-relevant turns.
 */
export function resolveTemporalContext(
  userMessage: string,
  sessionId: string,
  now: Date = new Date(),
  maxChars: number = MAX_CONTEXT_CHARS
): RetrievedContextResult {
  const explicitDates = extractExplicitDates(userMessage, now);
  const { dates: relativeDates } = extractRelativeDates(userMessage, now);

  const allDetectedDates = Array.from(new Set([...explicitDates, ...relativeDates]));
  const hasTemporalReference = allDetectedDates.length > 0 ||
    /\b(last|previous|yesterday|ago|since|earlier|before|shortlisted|asked you)\b/i.test(userMessage);

  const messageMap = new Map<number, Message>();

  // 1. Date-range filtered retrieval (when dates are detected)
  for (const dateStr of allDetectedDates) {
    // 1a. Date-filtered FTS search with BM25 ranking
    const dateFtsMessages = searchMessagesFTS(userMessage, {
      startDateStr: dateStr,
      endDateStr: dateStr,
      limit: 10
    });
    for (const msg of dateFtsMessages) {
      messageMap.set(msg.id, msg);
    }

    // 1b. All messages for detected date (guarantees retrieval even for non-keyword questions like "What did I ask on 3 November?")
    const dateAllMessages = searchMessagesByDateRange(null, dateStr, dateStr);
    for (const msg of dateAllMessages) {
      if (!messageMap.has(msg.id)) {
        messageMap.set(msg.id, { ...msg, rank: 0 });
      }
    }
  }

  // 2. Cross-session FTS search across all dates (handles arbitrary topics e.g. "that flight booking talk")
  const ftsMessages = searchMessagesFTS(userMessage, { limit: 20 });
  for (const msg of ftsMessages) {
    const existing = messageMap.get(msg.id);
    if (!existing) {
      messageMap.set(msg.id, msg);
    } else if (typeof msg.rank === 'number' && (typeof existing.rank !== 'number' || msg.rank < existing.rank)) {
      messageMap.set(msg.id, { ...existing, rank: msg.rank });
    }
  }

  // 3. Fallback: conversational recall phrasing when no specific date or FTS hits matched
  if (messageMap.size === 0 && /\b(asked you|we shortlisted|we discussed|shortlisted|remember)\b/i.test(userMessage)) {
    const recent = getRecentMessages(null, 6);
    for (const msg of recent) {
      messageMap.set(msg.id, { ...msg, rank: 0 });
    }
  }

  const allCandidates = Array.from(messageMap.values());

  // Rank and prioritize:
  // Preference 1: Matches resolved date AND has FTS match (bm25Score < 0)
  // Preference 2: Matches resolved date
  // Preference 3: Has FTS BM25 match (bm25Score < 0)
  // Preference 4: Others
  allCandidates.sort((a, b) => {
    const aDateMatch = allDetectedDates.includes(a.date_str);
    const bDateMatch = allDetectedDates.includes(b.date_str);
    const aRank = typeof a.rank === 'number' ? a.rank : 0;
    const bRank = typeof b.rank === 'number' ? b.rank : 0;

    // Both date match + FTS match
    const aBoth = aDateMatch && aRank < 0;
    const bBoth = bDateMatch && bRank < 0;
    if (aBoth && !bBoth) return -1;
    if (!aBoth && bBoth) return 1;
    if (aBoth && bBoth) return aRank - bRank;

    // Date match priority
    if (aDateMatch && !bDateMatch) return -1;
    if (!aDateMatch && bDateMatch) return 1;

    // FTS BM25 priority (lower/more negative is better)
    if (aRank < 0 && bRank < 0) return aRank - bRank;
    if (aRank < 0 && bRank >= 0) return -1;
    if (aRank >= 0 && bRank < 0) return 1;

    // Recency fallback
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Cap injected context to character/token budget
  let currentChars = 0;
  const selectedMessages: Message[] = [];

  for (const candidate of allCandidates) {
    const candidateLen = candidate.content.length + 150; // estimate overhead with headers
    if (selectedMessages.length > 0 && currentChars + candidateLen > maxChars) {
      continue;
    }
    selectedMessages.push(candidate);
    currentChars += candidateLen;
  }

  // Sort selected turns chronologically for coherent conversation flow
  selectedMessages.sort((a, b) => {
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  // Format into a structured context block with timestamps
  let formattedContext = '';
  if (selectedMessages.length > 0) {
    const lines: string[] = [
      '### [RETRIEVED PAST CONVERSATION MEMORY (CROSS-SESSION)] ###',
      'The following turns are retrieved from historical memory relevant to the user query:'
    ];

    for (const msg of selectedMessages) {
      const timeStr = msg.created_at.slice(0, 19).replace('T', ' ');
      lines.push(
        `\n[Session: ${msg.session_id} | Timestamp: ${timeStr} UTC | Date: ${msg.date_str} | Role: ${msg.role}]`
      );
      lines.push(msg.content);
    }

    lines.push('\n### [END OF RETRIEVED PAST CONVERSATION MEMORY] ###');
    formattedContext = lines.join('\n');
  }

  // Derive searchWindow from anchor date of retrieved past conversation or detected date
  let anchorDate: string | undefined;
  if (selectedMessages.length > 0) {
    // If a detected date matches a retrieved message, that is the primary anchor
    const matchedDetected = allDetectedDates.find(d => selectedMessages.some(m => m.date_str === d));
    anchorDate = matchedDetected || selectedMessages[0].date_str;
  } else if (allDetectedDates.length > 0) {
    anchorDate = allDetectedDates[0];
  }

  const searchWindow: SearchWindow | undefined = anchorDate ? { startDate: anchorDate } : undefined;

  return {
    hasTemporalReference,
    detectedDates: allDetectedDates,
    detectedKeywords: [],
    matchedMessages: selectedMessages,
    formattedContext,
    searchWindow
  };
}

