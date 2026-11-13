import * as chrono from 'chrono-node';
import {
  searchMessagesByDateRange,
  searchMessagesFTS,
  sanitizeFTSQuery,
  getRecentMessages,
  Message
} from '../db/memory.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface SearchWindow {
  startDate?: string; // YYYY-MM-DD
  endDate?: string;   // YYYY-MM-DD
}

export type DateConfidence = 'high' | 'medium' | 'low';

/** Structured result for a single parsed date/range */
export interface ParsedDateResult {
  startDate: string;          // YYYY-MM-DD
  endDate: string;            // YYYY-MM-DD
  confidence: DateConfidence;
  interpretationNote: string; // Explanation of the interpretation used
  sourceText: string;         // The matched text fragment
  isAmbiguous?: boolean;      // True if multiple interpretations are valid (e.g. 11/3)
}

export interface RetrievedContextResult {
  hasTemporalReference: boolean;
  detectedDates: string[];      // YYYY-MM-DD (flattened unique)
  detectedKeywords: string[];   // Deprecated: replaced by FTS5 query terms
  matchedMessages: Message[];
  formattedContext: string;
  searchWindow?: SearchWindow;
  parsedDates: ParsedDateResult[];
}

// Character budget for injected historical context (~1,000 tokens)
export const MAX_CONTEXT_CHARS = 4000;

// ─── Timezone Store & Helpers ─────────────────────────────────────────

/** In-memory per-user timezone store. Key = sessionId or userId. */
const userTimezones = new Map<string, string>();

export function setUserTimezone(userId: string, tz: string): void {
  userTimezones.set(userId, tz);
}

export function getUserTimezone(userId: string): string {
  return userTimezones.get(userId) || 'UTC';
}

/**
 * Returns a YYYY-MM-DD string for `date` interpreted in the given IANA timezone.
 * Uses Intl.DateTimeFormat with formatToParts to guarantee correct local calendar dates.
 */
export function formatDateInTz(date: Date, tz: string = 'UTC'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const y = parts.find(p => p.type === 'year')?.value;
    const m = parts.find(p => p.type === 'month')?.value;
    const d = parts.find(p => p.type === 'day')?.value;
    return `${y}-${m}-${d}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Checks whether an IANA timezone is Indian (e.g. Asia/Kolkata, Asia/Calcutta).
 */
export function isIndianTimezone(tz: string): boolean {
  const lower = tz.toLowerCase();
  return lower.includes('kolkata') || lower.includes('calcutta') || lower === 'ist';
}

// ─── chrono-node Date Parsing with Ambiguity Resolution ──────────────

/**
 * Parses temporal phrases using chrono-node combined with deterministic
 * timezone-aware handling for ambiguous numeric dates (11/3), "last week" ranges,
 * and midnight/week boundary calculations.
 */
export function parseDates(
  text: string,
  now: Date,
  tz: string = 'UTC'
): ParsedDateResult[] {
  const results: ParsedDateResult[] = [];
  const lower = text.toLowerCase();
  const indian = isIndianTimezone(tz);
  const matchedTokens = new Set<string>();

  // 1. Ambiguous numeric dates like 11/3, 5/6, 3/11
  // Indian timezone: DD/MM (day/month). Other timezones: MM/DD (month/day).
  const slashRegex = /\b(\d{1,2})\/(\d{1,2})\b/g;
  let slashMatch: RegExpExecArray | null;
  while ((slashMatch = slashRegex.exec(text)) !== null) {
    const a = parseInt(slashMatch[1], 10);
    const b = parseInt(slashMatch[2], 10);
    let day: number, month: number;
    const isAmbiguous = a <= 12 && b <= 12 && a !== b;

    if (indian) {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const todayInTz = formatDateInTz(now, tz);
      let year = parseInt(todayInTz.slice(0, 4), 10);
      const candidateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (candidateStr > todayInTz) {
        year = year - 1;
      }
      const finalDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      const interp = indian
        ? `Interpreted "${slashMatch[0]}" as day/month (DD/MM → ${day}/${month}) for timezone ${tz}`
        : `Interpreted "${slashMatch[0]}" as month/day (MM/DD → ${month}/${day}) for timezone ${tz}`;

      results.push({
        startDate: finalDateStr,
        endDate: finalDateStr,
        confidence: isAmbiguous ? 'low' : 'high',
        interpretationNote: interp + (isAmbiguous ? '. Date is ambiguous; the alternative month/day ordering is also valid.' : ''),
        sourceText: slashMatch[0],
        isAmbiguous
      });
      matchedTokens.add(slashMatch[0]);
    }
  }

  // 2. "last week" date range
  if (lower.includes('last week')) {
    const todayStr = formatDateInTz(now, tz);
    const [cy, cm, cd] = todayStr.split('-').map(Number);
    const localDay = new Date(Date.UTC(cy, cm - 1, cd));
    const dayOfWeek = localDay.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const diffToCurrentMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const currentMon = new Date(localDay);
    currentMon.setUTCDate(localDay.getUTCDate() - diffToCurrentMon);

    const lastMon = new Date(currentMon);
    lastMon.setUTCDate(currentMon.getUTCDate() - 7);

    const lastSun = new Date(lastMon);
    lastSun.setUTCDate(lastMon.getUTCDate() + 6);

    const startStr = lastMon.toISOString().slice(0, 10);
    const endStr = lastSun.toISOString().slice(0, 10);

    results.push({
      startDate: startStr,
      endDate: endStr,
      confidence: 'high',
      interpretationNote: `"last week" resolved to Monday-Sunday week range ${startStr} to ${endStr} in ${tz}`,
      sourceText: 'last week',
      isAmbiguous: false
    });
    matchedTokens.add('last week');
  }

  // 3. Relative day expressions anchored strictly to today in user timezone
  if (/\byesterday\b/i.test(text)) {
    const todayStr = formatDateInTz(now, tz);
    const [cy, cm, cd] = todayStr.split('-').map(Number);
    const d = new Date(Date.UTC(cy, cm - 1, cd));
    d.setUTCDate(d.getUTCDate() - 1);
    const yStr = d.toISOString().slice(0, 10);
    results.push({
      startDate: yStr,
      endDate: yStr,
      confidence: 'high',
      interpretationNote: `"yesterday" resolved to ${yStr} in ${tz}`,
      sourceText: 'yesterday',
      isAmbiguous: false
    });
    matchedTokens.add('yesterday');
  }

  if (/\bthis morning\b/i.test(text)) {
    const todayStr = formatDateInTz(now, tz);
    results.push({
      startDate: todayStr,
      endDate: todayStr,
      confidence: 'high',
      interpretationNote: `"this morning" resolved to ${todayStr} in ${tz}`,
      sourceText: 'this morning',
      isAmbiguous: false
    });
    matchedTokens.add('this morning');
  }

  // 4. Chrono-node parser for all natural language temporal phrases
  const chronoResults = chrono.parse(
    text,
    { instant: now, timezone: tz },
    { forwardDate: false }
  );

  for (const r of chronoResults) {
    const rLower = r.text.toLowerCase();
    if (
      matchedTokens.has(rLower) ||
      matchedTokens.has(r.text) ||
      rLower.includes('last week') ||
      rLower.includes('yesterday') ||
      rLower.includes('this morning')
    ) {
      continue;
    }

    const c = r.start;
    let year = c.get('year');
    const month = c.get('month');
    const day = c.get('day');
    if (!year || !month || !day) continue;

    const todayStr = formatDateInTz(now, tz);
    let startStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // If candidate date is strictly in the future relative to today in tz, and the user didn't mention year, adjust to past year
    if (startStr > todayStr && !r.text.includes(String(year))) {
      year = year - 1;
      startStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    let endStr = startStr;
    if (r.end) {
      let ey = r.end.get('year') || year;
      const em = r.end.get('month');
      const ed = r.end.get('day');
      if (em && ed) {
        endStr = `${ey}-${String(em).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
      }
    }

    results.push({
      startDate: startStr,
      endDate: endStr,
      confidence: 'high',
      interpretationNote: `"${r.text}" resolved to ${startStr}${endStr !== startStr ? ` to ${endStr}` : ''} in ${tz}`,
      sourceText: r.text,
      isAmbiguous: false
    });
  }

  return results;
}

// ─── Main Temporal Resolver ──────────────────────────────────────────

/**
 * Resolves temporal context and retrieves matching historical messages from SQLite.
 * Uses chrono-node and timezone-aware date parsing, combined with FTS5 BM25 ranking.
 */
export function resolveTemporalContext(
  userMessage: string,
  sessionId: string,
  now: Date = new Date(),
  maxChars: number = MAX_CONTEXT_CHARS,
  tz?: string
): RetrievedContextResult {
  const effectiveTz = tz || getUserTimezone(sessionId) || 'UTC';
  const parsedDates = parseDates(userMessage, now, effectiveTz);

  // Flatten unique dates (expanding date ranges if applicable)
  const allDetectedDates: string[] = [];
  for (const pd of parsedDates) {
    if (pd.startDate === pd.endDate) {
      if (!allDetectedDates.includes(pd.startDate)) {
        allDetectedDates.push(pd.startDate);
      }
    } else {
      const start = new Date(pd.startDate + 'T00:00:00Z');
      const end = new Date(pd.endDate + 'T00:00:00Z');
      const maxDays = 14;
      let count = 0;
      for (let d = new Date(start); d <= end && count < maxDays; d.setDate(d.getDate() + 1), count++) {
        const ds = d.toISOString().slice(0, 10);
        if (!allDetectedDates.includes(ds)) {
          allDetectedDates.push(ds);
        }
      }
    }
  }

  const hasTemporalReference = allDetectedDates.length > 0 ||
    /\b(last|previous|yesterday|ago|since|earlier|before|shortlisted|asked you|this morning|this evening)\b/i.test(userMessage);

  const messageMap = new Map<number, Message>();

  // 1. Date-range filtered retrieval
  for (const dateStr of allDetectedDates) {
    const dateFtsMessages = searchMessagesFTS(userMessage, {
      startDateStr: dateStr,
      endDateStr: dateStr,
      limit: 10
    });
    for (const msg of dateFtsMessages) {
      messageMap.set(msg.id, msg);
    }

    const dateAllMessages = searchMessagesByDateRange(null, dateStr, dateStr);
    for (const msg of dateAllMessages) {
      if (!messageMap.has(msg.id)) {
        messageMap.set(msg.id, { ...msg, rank: 0 });
      }
    }
  }

  // 2. Cross-session FTS search across all dates
  const ftsMessages = searchMessagesFTS(userMessage, { limit: 20 });
  for (const msg of ftsMessages) {
    const existing = messageMap.get(msg.id);
    if (!existing) {
      messageMap.set(msg.id, msg);
    } else if (typeof msg.rank === 'number' && (typeof existing.rank !== 'number' || msg.rank < existing.rank)) {
      messageMap.set(msg.id, { ...existing, rank: msg.rank });
    }
  }

  // 3. Fallback: conversational recall phrasing
  if (messageMap.size === 0 && /\b(asked you|we shortlisted|we discussed|shortlisted|remember)\b/i.test(userMessage)) {
    const recent = getRecentMessages(null, 6);
    for (const msg of recent) {
      messageMap.set(msg.id, { ...msg, rank: 0 });
    }
  }

  const allCandidates = Array.from(messageMap.values());

  allCandidates.sort((a, b) => {
    const aDateMatch = allDetectedDates.includes(a.date_str);
    const bDateMatch = allDetectedDates.includes(b.date_str);
    const aRank = typeof a.rank === 'number' ? a.rank : 0;
    const bRank = typeof b.rank === 'number' ? b.rank : 0;

    const aBoth = aDateMatch && aRank < 0;
    const bBoth = bDateMatch && bRank < 0;
    if (aBoth && !bBoth) return -1;
    if (!aBoth && bBoth) return 1;
    if (aBoth && bBoth) return aRank - bRank;

    if (aDateMatch && !bDateMatch) return -1;
    if (!aDateMatch && bDateMatch) return 1;

    if (aRank < 0 && bRank < 0) return aRank - bRank;
    if (aRank < 0 && bRank >= 0) return -1;
    if (aRank >= 0 && bRank < 0) return 1;

    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  let currentChars = 0;
  const selectedMessages: Message[] = [];

  for (const candidate of allCandidates) {
    const candidateLen = candidate.content.length + 150;
    if (selectedMessages.length > 0 && currentChars + candidateLen > maxChars) {
      continue;
    }
    selectedMessages.push(candidate);
    currentChars += candidateLen;
  }

  selectedMessages.sort((a, b) => {
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  let formattedContext = '';
  const contextNotes: string[] = [];

  // Ambiguity notes if any ambiguous date was parsed
  const ambiguousDates = parsedDates.filter(p => p.isAmbiguous || p.confidence === 'low');
  for (const amb of ambiguousDates) {
    contextNotes.push(
      `[AMBIGUOUS DATE REFERENCE]: "${amb.sourceText}" was interpreted as ${amb.startDate} (${amb.interpretationNote}). ` +
      `If no historical conversation exists for this date, explicitly state that the date is ambiguous and identify the interpretation you used rather than guessing.`
    );
  }

  if (selectedMessages.length > 0) {
    const lines: string[] = [
      '### [RETRIEVED PAST CONVERSATION MEMORY (CROSS-SESSION)] ###',
      'The following turns are retrieved from historical memory relevant to the user query:'
    ];

    if (contextNotes.length > 0) {
      lines.push(...contextNotes);
    }

    for (const msg of selectedMessages) {
      const timeStr = msg.created_at.slice(0, 19).replace('T', ' ');
      lines.push(
        `\n[Session: ${msg.session_id} | Timestamp: ${timeStr} UTC | Date (${effectiveTz}): ${msg.date_str} | Role: ${msg.role}]`
      );
      lines.push(msg.content);
    }

    lines.push('\n### [END OF RETRIEVED PAST CONVERSATION MEMORY] ###');
    formattedContext = lines.join('\n');
  } else if (contextNotes.length > 0) {
    formattedContext = contextNotes.join('\n');
  }

  // Derive searchWindow from anchor date
  let anchorDate: string | undefined;
  if (selectedMessages.length > 0) {
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
    searchWindow,
    parsedDates
  };
}
