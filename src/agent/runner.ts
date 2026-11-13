import dotenv from 'dotenv';
dotenv.config();

import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';
import {
  insertMessage,
  getRecentMessages,
  Message
} from '../db/memory.js';
import {
  resolveTemporalContext,
  MAX_CONTEXT_CHARS,
  formatDateInTz,
  getUserTimezone
} from '../context/temporalResolver.js';
import {
  webSearchToolDeclaration,
  executeWebSearch,
  WebSearchArgs,
  TAVILY_PUBLISH_DATE_NOTE
} from '../tools/webSearch.js';

export type AgentEventType =
  | 'status'
  | 'tool_start'
  | 'tool_end'
  | 'token'
  | 'done'
  | 'error';

export interface AgentEvent {
  type: AgentEventType;
  message?: string;
  queries?: string[];
  resultCount?: number;
  durationMs?: number;
  content?: string;
  error?: string;
}

export type AgentEventCallback = (event: AgentEvent) => void;

/**
 * Builds a 14-day relative calendar mapping from the perspective of `now` in the user's timezone.
 */
export function buildCalendarReference(now: Date = new Date(), tz: string = 'UTC'): string {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const lines: string[] = [];
  const currentDateStr = formatDateInTz(now, tz);
  const [yNum, mNum, dNum] = currentDateStr.split('-').map(Number);
  const localMid = new Date(Date.UTC(yNum, mNum - 1, dNum));
  const currentDayName = dayNames[localMid.getUTCDay()];
  const currentMonthName = monthNames[mNum - 1];

  let timeStr = '12:00';
  try {
    timeStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(now);
  } catch {
    timeStr = now.toISOString().slice(11, 16);
  }

  lines.push(`TODAY: ${currentDayName}, ${currentMonthName} ${dNum}, ${yNum} (${currentDateStr} ${timeStr} ${tz})`);
  lines.push(`RELATIVE CALENDAR MAPPING (Past 14 Days Reference in ${tz}):`);

  for (let i = 0; i <= 14; i++) {
    const d = new Date(localMid);
    d.setUTCDate(localMid.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayName = dayNames[d.getUTCDay()];
    const mName = monthNames[d.getUTCMonth()];
    const dayVal = d.getUTCDate();
    const label = i === 0 ? '[TODAY]' : i === 1 ? '[YESTERDAY]' : `[${i} days ago]`;
    lines.push(`- ${dateStr} (${dayName}, ${mName} ${dayVal}) ${label}`);
  }

  return lines.join('\n');
}

/**
 * Constructs the system prompt with calendar anchors, retrieved historical memory, and operational rules.
 */
export function buildSystemPrompt(now: Date, pastContext: string, tz: string = 'UTC'): string {
  const calendarRef = buildCalendarReference(now, tz);

  return `You are an elite, high-performance Chat Agent with temporal reasoning and live web verification capabilities.

=== CURRENT TEMPORAL CONTEXT ===
${calendarRef}

=== HISTORICAL CONVERSATION MEMORY ===
${pastContext || 'No relevant past cross-session conversation memory detected.'}

=== OPERATIONAL INSTRUCTIONS & RULES ===
1. TEMPORAL ACCURACY & RESOLUTION:
   - Anchor all temporal queries strictly to the CALENDAR REFERENCE table above.
   - When the user asks about "Monday", "Last Tuesday", "3 November", or "yesterday", cross-reference with the exact dates indicated in the reference table and the historical conversation memory above.

2. BATCHED PARALLEL WEB SEARCH:
   - You have strictly ONE tool: \`web_search\`.
   - When asked to verify if any pricing, release version, or feature has changed since a past date, decompose your verification into 1 to 6 targeted, concurrent queries inside a SINGLE \`web_search\` call.
   - Include specific vendor/product names, the current year/month, and keywords like "pricing", "plans", "release notes", or "changelog" (e.g., ["HubSpot Sales Hub pricing 2026", "Pipedrive pricing changes", "Attio CRM pricing", "Close CRM plans", "Folk CRM pricing"]).

3. TEMPORAL DIFF & COMPARISON:
   - When checking changes since Date X, perform an explicit TEMPORAL DIFF:
     * Baseline: What was stated or shortlisted in the historical conversation on that date.
     * Current Live Reality: What live web results show as of today (${formatDateInTz(now, tz)}).
     * Diff Analysis: Explicitly detail what changed (price increases/decreases, new tiers, limits) and what remains identical.
     * Be precise with numbers, tiers, and specs.

4. FACTUAL CITATIONS, BREVITY & TONE:
   - Ground every live factual claim with markdown citations: \`[Source Title](url)\`.
   - Be direct, concise, and structured. Avoid lengthy conversational filler or generic preambles.
   - For comparisons, prioritize compact Markdown tables and high-density bullet points so the user gets facts immediately.

5. STRICT ANTI-FABRICATION RULE & AMBIGUOUS DATE RESOLUTION:
   - If the user refers to a past conversation, prior discussion, shortlist, question, or specific date (e.g., "what did I ask on 3 November?", "on Monday we shortlisted...", "last Tuesday I asked you about..."), and the HISTORICAL CONVERSATION MEMORY section above is empty or does NOT contain any matching record of that conversation:
     * You MUST explicitly state that you have no record of that prior conversation or question for that date/topic.
     * Ask the user to share the details or provide context.
     * You must NEVER invent, assume, simulate, or fabricate prior conversation content, previous questions, or past shortlists.
   - If a date reference is ambiguous (e.g. numeric "11/3" which could be 11 March in DD/MM or 3 November in MM/DD):
     * Explicitly state the ambiguity and identify which interpretation you used (e.g. "Interpreted '11/3' as day/month for your timezone").
     * If no records exist for that date under that interpretation, explicitly state that you have no record for that date rather than guessing.

6. ABSENCE OF RESULTS IS NOT EVIDENCE OF NO CHANGE:
   - Absence of results is not evidence of no change.
   - Tavily filters by publish date. Pages edited after publishing may not appear.
   - If no updates or changes are returned for a provider, do not assert with certainty that nothing changed. Explicitly say what you searched, the date window evaluated (e.g., "since [YYYY-MM-DD]"), and that no relevant news or published updates were found.`;
}

export interface RunAgentOptions {
  forceSequentialSearch?: boolean;
  thinkingBudget?: number;
  timezone?: string;
}

/**
 * Runs the agent loop:
 * 1. Saves user message to SQLite.
 * 2. Pre-retrieves temporal cross-session context.
 * 3. Builds system prompt and fetches active session history.
 * 4. Executes multi-turn tool calling loop (max 4 iterations).
 * 5. Streams tokens and progress events via onEvent callback.
 * 6. Saves assistant response to SQLite.
 */
export async function runAgent(
  userMessage: string,
  sessionId: string = 'default-session',
  onEvent: AgentEventCallback = () => { },
  refDate: Date = new Date(),
  options: RunAgentOptions = {}
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const errorMsg = 'GEMINI_API_KEY is not configured in environment.';
    onEvent({ type: 'error', error: errorMsg });
    onEvent({ type: 'token', content: `Configuration Error: ${errorMsg}` });
    onEvent({ type: 'done' });
    return errorMsg;
  }

  const modelName = process.env.MODEL_NAME || 'gemini-3.1-flash-lite';
  const effectiveTz = options.timezone || getUserTimezone(sessionId) || 'UTC';
  const now = refDate;
  const isoNow = now.toISOString();

  // 1. Save incoming user message to SQLite (computing date_str in user timezone)
  insertMessage(sessionId, 'user', userMessage, isoNow, null, false, effectiveTz);

  // 2. Pre-Retrieval Context Resolution (before LLM call)
  const temporalRes = resolveTemporalContext(userMessage, sessionId, now, MAX_CONTEXT_CHARS, effectiveTz);
  if (temporalRes.matchedMessages.length > 0) {
    const datesDesc = temporalRes.detectedDates.length > 0
      ? temporalRes.detectedDates.join(', ')
      : 'cross-session history';
    onEvent({
      type: 'status',
      message: `Retrieved historical memory (${temporalRes.matchedMessages.length} turns matched for ${datesDesc})`
    });
  }

  // 3. Assemble System Prompt & Conversation History in user timezone
  const systemPrompt = buildSystemPrompt(now, temporalRes.formattedContext, effectiveTz);

  // Fetch recent messages for active session context (last 10 turns)
  const recentTurns = getRecentMessages(sessionId, 10);

  // Build initial contents for Gemini SDK
  const contents: any[] = [];
  for (const turn of recentTurns) {
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }]
    });
  }

  // Initialize Gemini client
  const ai = new GoogleGenAI({ apiKey });

  // Deterministic intent check before the first model call:
  // If message contains change/current-state wording (still, changed, since, current, latest, now, pricing, new)
  // or temporal resolver anchored to a past conversation, force first turn to call web_search.
  const changeCurrentRegex = /\b(still|changed|since|current|latest|now|pricing|new)\b/i;
  const hasChangeWording = changeCurrentRegex.test(userMessage);
  const hasAnchoredPastConvo =
    (temporalRes.hasTemporalReference || temporalRes.detectedDates.length > 0) &&
    temporalRes.matchedMessages.length > 0;
  const shouldForceSearchFirstTurn = hasChangeWording || hasAnchoredPastConvo;

  let finalAnswer = '';
  const maxIterations = 4;
  let iteration = 0;

  try {
    while (iteration < maxIterations) {
      iteration++;

      // Configure function calling mode: force ANY on iteration 1 if intent triggers, otherwise AUTO
      const forceThisTurn = iteration === 1 && shouldForceSearchFirstTurn;
      const functionCallingConfig = forceThisTurn
        ? {
          mode: FunctionCallingConfigMode.ANY,
          allowedFunctionNames: ['web_search']
        }
        : {
          mode: FunctionCallingConfigMode.AUTO
        };

      console.log(
        `[Agent Runner Turn ${iteration}] Function calling path: ${forceThisTurn ? 'FORCED (mode: ANY)' : 'AUTO (mode: AUTO)'} ` +
        `[reason: ${forceThisTurn ? (hasChangeWording ? 'change/current wording' : 'anchored past memory') : 'default/subsequent turn'}]`
      );

      const streamConfig: any = {
        systemInstruction: systemPrompt,
        tools: [{
          functionDeclarations: [webSearchToolDeclaration]
        }],
        toolConfig: {
          functionCallingConfig
        },
        temperature: 0.2,
        maxOutputTokens: 1500
      };

      if (typeof options.thinkingBudget === 'number') {
        streamConfig.thinkingConfig = {
          thinkingBudget: options.thinkingBudget
        };
      }

      // Request stream from Gemini with transient error backoff (429 rate limit or 503 high demand)
      let responseStream: any = null;
      let retriesLeft = 3;
      while (retriesLeft >= 0) {
        try {
          responseStream = await ai.models.generateContentStream({
            model: modelName,
            contents,
            config: streamConfig
          });
          break;
        } catch (apiErr: any) {
          const isRateLimit = apiErr?.status === 429 || String(apiErr?.message).includes('429');
          const isHighDemand = apiErr?.status === 503 || String(apiErr?.message).includes('503');
          if ((isRateLimit || isHighDemand) && retriesLeft > 0) {
            retriesLeft--;
            const delaySec = isRateLimit ? 12 : 3;
            console.warn(`[Agent Runner] Gemini API ${isRateLimit ? '429 Rate Limit' : '503 High Demand'}. Backing off for ${delaySec}s before retry...`);
            await new Promise((r) => setTimeout(r, delaySec * 1000));
          } else {
            throw apiErr;
          }
        }
      }

      let iterationText = '';
      const functionCalls: any[] = [];
      let modelContent: any = null;

      for await (const chunk of responseStream) {
        if (chunk.candidates?.[0]?.content) {
          modelContent = chunk.candidates[0].content;
        }

        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          for (const fc of chunk.functionCalls) {
            functionCalls.push(fc);
          }
        }

        // Only stream tokens if model is not calling tools
        if (chunk.text && functionCalls.length === 0) {
          iterationText += chunk.text;
          onEvent({ type: 'token', content: chunk.text });
        }
      }

      // Check if model requested tool execution
      if (functionCalls.length > 0) {
        // Append model's original turn to contents to preserve thought signatures
        if (modelContent) {
          contents.push(modelContent);
        } else {
          contents.push({
            role: 'model',
            parts: functionCalls.map((fc) => ({ functionCall: fc }))
          });
        }

        const responseParts: any[] = [];

        for (const call of functionCalls) {
          if (call.name === 'web_search') {
            const rawArgs = call.args as WebSearchArgs;
            const queries = Array.isArray(rawArgs?.queries)
              ? rawArgs.queries
              : [String(rawArgs?.queries || '')];

            onEvent({ type: 'tool_start', queries });

            const startTime = Date.now();
            const searchResults = await executeWebSearch(
              rawArgs,
              Boolean(options.forceSequentialSearch),
              temporalRes.searchWindow?.startDate
            );
            const durationMs = Date.now() - startTime;

            onEvent({
              type: 'tool_end',
              resultCount: searchResults.length,
              durationMs
            });

            const funcResponseObj: any = {
              name: call.name,
              response: {
                results: searchResults,
                note: TAVILY_PUBLISH_DATE_NOTE
              }
            };
            if (call.id) {
              funcResponseObj.id = call.id;
            }

            responseParts.push({
              functionResponse: funcResponseObj
            });
          }
        }

        // Append tool response turn to contents (in Gemini, role is 'user')
        if (responseParts.length > 0) {
          contents.push({
            role: 'user',
            parts: responseParts
          });
        }

        // Continue loop to allow model to synthesize search results
        continue;
      }

      // If no function call, iterationText is our final answer
      finalAnswer = iterationText;
      break;
    }

    if (!finalAnswer && iteration >= maxIterations) {
      finalAnswer = 'Reached maximum reasoning steps without producing final answer.';
      onEvent({ type: 'token', content: finalAnswer });
    }

    // 4. Save final assistant response to SQLite (computing date_str in user timezone)
    insertMessage(sessionId, 'assistant', finalAnswer, new Date().toISOString(), null, false, effectiveTz);
    onEvent({ type: 'done' });
    return finalAnswer;

  } catch (error: any) {
    console.error('[Agent Runner Error]:', error);
    const errorMsg = error?.message || 'Unknown agent execution error';
    onEvent({ type: 'error', error: errorMsg });
    onEvent({ type: 'token', content: `\n[Agent Error: ${errorMsg}]` });
    onEvent({ type: 'done' });
    return errorMsg;
  }
}

