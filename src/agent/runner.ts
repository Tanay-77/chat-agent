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
  WebSearchResultItem,
  TAVILY_PUBLISH_DATE_NOTE
} from '../tools/webSearch.js';
import { simplifyErrorMessage } from '../utils/errorFormatter.js';

export type AgentEventType =
  | 'status'
  | 'trace'
  | 'tool_start'
  | 'tool_end'
  | 'token'
  | 'done'
  | 'error';

export interface AgentEvent {
  type: AgentEventType;
  step?: 'memory' | 'search';
  found?: number;
  snippets?: Array<{ date: string; text: string }>;
  queries?: number | string[];
  results?: number;
  ms?: number;
  resultCount?: number;
  durationMs?: number;
  text?: string;
  message?: string;
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

IMPORTANT NOTE ON RETRIEVED MEMORY:
Retrieved past conversation is what the USER said or what the assistant claimed earlier. It is NOT a source of current facts. Never state a version, price, date or status from past conversation or from model memory. Current facts must come from this turn's search results only.
However, user personal context and statements (e.g., the user's name, preferences, or stated details) MUST be recalled directly from what the user stated in the historical conversation memory above.

=== OPERATIONAL INSTRUCTIONS & RULES ===
1. TEMPORAL ACCURACY & RESOLUTION:
   - Anchor all temporal queries strictly to the CALENDAR REFERENCE table above.
   - When the user asks about "Monday", "Last Tuesday", "3 November", or "yesterday", cross-reference with the exact dates indicated in the reference table and the historical conversation memory above.

2. BATCHED PARALLEL WEB SEARCH:
   - You have strictly ONE tool: \`web_search\`.
   - When asked to verify if any pricing, release version, or feature has changed since a past date, decompose your verification into 1 to 6 targeted, concurrent queries inside a SINGLE \`web_search\` call.
   - Include specific vendor/product names, the current year/month, and keywords like "pricing", "plans", "release notes", or "changelog" (e.g., ["HubSpot Sales Hub pricing 2026", "Pipedrive pricing changes", "Attio CRM pricing", "Close CRM plans", "Folk CRM pricing"]).

3. GROUNDING & ANTI-CONTAMINATION (CRITICAL):
   - Retrieved past conversation is what the USER said or what the assistant claimed earlier. It is NOT a source of current facts. Never state a version, price, date or status from past conversation or from model memory. Current facts must come from this turn's search results only.
   - Every version number, price, date, or status in the answer must appear in the search results provided. If results don't contain it or conflict, say so and give what the results do say. Never write a release date that isn't in the results.

4. TEMPORAL DIFF & COMPARISON:
   - When checking changes since Date X, perform an explicit TEMPORAL DIFF:
     * Baseline: What was stated or shortlisted in the historical conversation on that date.
     * Current Live Reality: What live web results show as of today (${formatDateInTz(now, tz)}).
     * Diff Analysis: Explicitly detail what changed (price increases/decreases, new tiers, limits) and what remains identical.
     * Be precise with numbers, tiers, and specs.

5. ANSWER FORMAT & CITATIONS:
   - Cite sources inline, with a link to the specific page for each key claim (not just a homepage), e.g., \`[Source Title](url)\`.
   - Be direct, concise, and structured. Avoid lengthy conversational filler or generic preambles.
   - For comparisons, prioritize compact Markdown tables and high-density bullet points so the user gets facts immediately.

6. STRICT ANTI-FABRICATION RULE & AMBIGUOUS DATE RESOLUTION:
   - If the user refers to a past conversation, prior discussion, shortlist, question, or specific date (e.g., "what did I ask on 3 November?", "on Monday we shortlisted...", "last Tuesday I asked you about..."), and the HISTORICAL CONVERSATION MEMORY section above is empty or does NOT contain any matching record of that conversation:
     * You MUST explicitly state that you have no record of that prior conversation or question for that date/topic.
     * Ask the user to share the details or provide context.
     * You must NEVER invent, assume, simulate, or fabricate prior conversation content, previous questions, or past shortlists.
   - If a date reference is ambiguous (e.g. numeric "11/3" which could be 11 March in DD/MM or 3 November in MM/DD):
     * Explicitly state the ambiguity and identify which interpretation you used (e.g. "Interpreted '11/3' as day/month for your timezone").
     * If no records exist for that date under that interpretation, explicitly state that you have no record for that date rather than guessing.

7. ABSENCE OF RESULTS IS NOT EVIDENCE OF NO CHANGE:
   - Absence of results is not evidence of no change.
   - Tavily filters by publish date. Pages edited after publishing may not appear.
   - If no updates or changes are returned for a provider, do not assert with certainty that nothing changed. Explicitly say what you searched, the date window evaluated (e.g., "since [YYYY-MM-DD]"), and that no relevant news or published updates were found.`;
}

export type IntentCase = 'RECALL' | 'VERIFY' | 'AUTO';

export interface IntentResult {
  intent: IntentCase;
  reason: string;
  firstTurnMode: FunctionCallingConfigMode;
}

/**
 * Classifies the user's intent into three distinct paths:
 * 1. RECALL: User asks what they said or asked ("what did I tell you", "what did I ask", "do you remember").
 *    Use memory only. First-turn tool mode NONE, so no web_search. Answer from retrieved history.
 * 2. VERIFY: User asks whether something from earlier is still true, changed, or current
 *    ("still correct", "changed since", "any updates", "is that still the price")
 *    or uses latest/current/pricing wording about a topic.
 *    Force web_search on the first turn, with search window starting at anchor conversation date.
 * 3. AUTO: Everything else. Tool mode AUTO (no forced search).
 */
export function classifyIntent(
  userMessage: string,
  temporalRes?: {
    hasTemporalReference?: boolean;
    detectedDates?: string[];
    matchedMessages?: any[];
    searchWindow?: { startDate?: string; endDate?: string };
  }
): IntentResult {
  const text = userMessage.trim();

  // 1. VERIFY: asks whether something from earlier is still true, changed, or current,
  // or uses latest/current/pricing wording about a topic.
  const verifyPastStatePatterns = [
    /\bstill\s+(correct|true|valid|accurate|the\s+same|the\s+price|in\s+effect|active)\b/i,
    /\b(is|are|was|were)\s+.*?\bstill\b/i,
    /\bchanged\s+since\b/i,
    /\bany\s+(updates|changes|new\s+releases|new\s+features)\b/i,
    /\bhas\s+.*?\b(changed|updated|increased|decreased)\b/i,
    /\bhas\s+(anything|any(\s+of\s+them)?|it|pricing)\s+changed\b/i,
    /\b(shipped|released|launched)\s+.*?\bsince\b/i,
    /\b(change|changes|changed)\s+since\b/i
  ];

  const verifyTopicPatterns = [
    /\b(latest|current|newest)\b/i,
    /\b(pricing|price|plans|subscription\s+rates|tier\s+pricing)\b/i
  ];

  const hasVerifyPastState = verifyPastStatePatterns.some((pattern) => pattern.test(text));
  const hasVerifyTopic = verifyTopicPatterns.some((pattern) => pattern.test(text));

  const hasContextualChange =
    /\b(any\s+changes|did\s+anything\s+change|has\s+it\s+changed)\b/i.test(text) &&
    Boolean(temporalRes?.hasTemporalReference || (temporalRes?.matchedMessages && temporalRes.matchedMessages.length > 0));

  if (hasVerifyPastState || hasVerifyTopic || hasContextualChange) {
    const reason = hasVerifyPastState
      ? 'User asked whether past information is still true, changed, or current'
      : hasVerifyTopic
      ? 'User query contains latest/current/pricing wording about a topic'
      : 'User asked if anything changed relative to retrieved conversation';

    return {
      intent: 'VERIFY',
      reason,
      firstTurnMode: FunctionCallingConfigMode.ANY
    };
  }

  // 2. RECALL: user is asking what they said or asked ("what did I tell you", "what did I ask", "do you remember")
  // or asking to recall their identity, name, or personal stated attributes ("what is my name", "who am I").
  const recallPatterns = [
    /\bwhat\s+did\s+(i|we)\s+(tell\s+you|ask(\s+you)?|say|mention|shortlist|discuss|talk\s+about|decide)\b/i,
    /\bwhat\s+(was|were)\s+(the\s+|my\s+|our\s+)?(shortlist|question(s)?|discussion|options|recommendation(s)?)\b/i,
    /\bdo\s+you\s+remember\b/i,
    /\bdid\s+i\s+(tell\s+you|ask(\s+you)?|mention|say)\b/i,
    /\b(tell\s+me|remind\s+me)\s+what\s+(i|we)\s+(said|told\s+you|asked|discussed|talked\s+about)\b/i,
    /\bwhat\s+did\s+i\s+tell\s+you\b/i,
    /\b(what\s+is|what's)\s+my\s+(name|job|role|title|email|city|location|preference|plan|stack)\b/i,
    /\bwho\s+am\s+i\b/i,
    /\bdo\s+you\s+know\s+(my\s+name|who\s+i\s+am)\b/i,
    /\b(tell\s+me|remind\s+me)\s+(my\s+name|who\s+i\s+am)\b/i,
    /\bmy\s+name\b/i
  ];

  const isRecall = recallPatterns.some((pattern) => pattern.test(text));
  if (isRecall) {
    return {
      intent: 'RECALL',
      reason: 'User asked what they said or asked in earlier conversation (memory recall only)',
      firstTurnMode: FunctionCallingConfigMode.NONE
    };
  }

  // 3. AUTO: everything else
  return {
    intent: 'AUTO',
    reason: 'Standard conversational query without forced verification or recall',
    firstTurnMode: FunctionCallingConfigMode.AUTO
  };
}

export interface RunAgentOptions {
  forceSequentialSearch?: boolean;
  thinkingBudget?: number;
  timezone?: string;
  userId?: string;
  mockSearchResults?: WebSearchResultItem[];
  signal?: AbortSignal;
}

/**
 * Runs the agent loop:
 * 1. Emits immediate SSE status event.
 * 2. Saves user message and runs pre-retrieval pipeline.
 * 3. Enforces search policy (Turn 1 search -> optional 1 retry if 0/stale -> Turn 2 synthesis with mode: NONE).
 * 4. Logs per-call metrics and final stage breakdown.
 * 5. Streams synthesis tokens and saves assistant response.
 */
export async function runAgent(
  userMessage: string,
  sessionId: string = 'default-session',
  onEvent: AgentEventCallback = () => { },
  refDate: Date = new Date(),
  options: RunAgentOptions = {}
): Promise<string> {
  const requestStartTime = performance.now();

  if (options.signal?.aborted) {
    onEvent({ type: 'done' });
    return '';
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const errorMsg = 'GEMINI_API_KEY is not configured in environment.';
    onEvent({ type: 'error', error: errorMsg });
    onEvent({ type: 'token', content: `Configuration Error: ${errorMsg}` });
    onEvent({ type: 'done' });
    return errorMsg;
  }

  // 1. Emit short transient status event for loading indicator (does not create trace pill)
  onEvent({
    type: 'status',
    text: 'Working…',
    message: 'Working…'
  });

  const modelName = process.env.MODEL_NAME || 'gemini-3.1-flash-lite';
  const effectiveUserId = options.userId || 'default-user';
  const effectiveTz = options.timezone || getUserTimezone(effectiveUserId) || getUserTimezone(sessionId) || 'UTC';
  const now = refDate;
  const isoNow = now.toISOString();

  // 2. Pre-Retrieval Stage
  const preRetrievalStart = performance.now();

  const temporalRes = resolveTemporalContext(userMessage, sessionId, now, MAX_CONTEXT_CHARS, effectiveTz, effectiveUserId);
  const memoryBlock = temporalRes.formattedContext ? temporalRes.formattedContext.trim() : 'none';
  console.log(`[Agent Runner Request ${sessionId}] Retrieved Memory:\n${memoryBlock}`);

  // Send structured trace event AFTER retrieval finishes with N earlier messages injected into prompt (including N=0)
  onEvent({
    type: 'trace',
    step: 'memory',
    found: temporalRes.matchedMessages.length,
    snippets: temporalRes.matchedMessages.map((m) => ({
      date: m.date_str || m.created_at.slice(0, 10),
      text: m.content
    }))
  });

  // Insert current user message after resolving historical context so current message is not self-retrieved as past memory
  insertMessage(sessionId, 'user', userMessage, isoNow, null, false, effectiveTz, effectiveUserId);

  const systemPrompt = buildSystemPrompt(now, temporalRes.formattedContext, effectiveTz);
  const recentTurns = getRecentMessages(sessionId, 10, effectiveUserId);

  const contents: any[] = [];
  for (const turn of recentTurns) {
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }]
    });
  }

  const preRetrievalDurationMs = Math.round(performance.now() - preRetrievalStart);

  // Initialize Gemini client & thinking budget (lowest supported: 0 = disabled)
  const ai = new GoogleGenAI({ apiKey });
  const effectiveThinkingBudget = typeof options.thinkingBudget === 'number'
    ? options.thinkingBudget
    : 0;

  // Helper for per-call execution, timing, retry, and logging
  async function executeGeminiCall(params: {
    label: string;
    mode: FunctionCallingConfigMode;
    allowedFunctionNames?: string[];
    streamTokens: boolean;
  }): Promise<{
    text: string;
    functionCalls: any[];
    modelContent: any;
    durationMs: number;
  }> {
    if (options.signal?.aborted) {
      return { text: '', functionCalls: [], modelContent: null, durationMs: 0 };
    }
    const { label, mode, allowedFunctionNames, streamTokens } = params;
    const callStart = performance.now();

    const functionCallingConfig: any = { mode };
    if (mode === FunctionCallingConfigMode.ANY && allowedFunctionNames) {
      functionCallingConfig.allowedFunctionNames = allowedFunctionNames;
    }

    const streamConfig: any = {
      systemInstruction: systemPrompt,
      temperature: 0.2,
      maxOutputTokens: 1500,
      toolConfig: { functionCallingConfig },
      thinkingConfig: { thinkingBudget: effectiveThinkingBudget }
    };

    if (options.signal) {
      streamConfig.abortSignal = options.signal;
    }

    if (mode !== FunctionCallingConfigMode.NONE) {
      streamConfig.tools = [{ functionDeclarations: [webSearchToolDeclaration] }];
    }

    let responseStream: any = null;
    let retryCount = 0;
    let httpStatus = 200;

    for (let attempt = 0; attempt <= 2; attempt++) {
      if (options.signal?.aborted) {
        return { text: '', functionCalls: [], modelContent: null, durationMs: 0 };
      }
      try {
        responseStream = await ai.models.generateContentStream({
          model: modelName,
          contents,
          config: streamConfig
        });
        httpStatus = 200;
        break;
      } catch (apiErr: any) {
        if (options.signal?.aborted) {
          return { text: '', functionCalls: [], modelContent: null, durationMs: 0 };
        }
        const status = apiErr?.status || (String(apiErr?.message).includes('429') ? 429 : String(apiErr?.message).includes('503') ? 503 : 500);
        httpStatus = status;
        const isRetryable = status === 429 || status === 503;
        if (isRetryable && attempt < 2) {
          retryCount = attempt + 1;
          const backoffMs = (attempt + 1) * (status === 429 ? 2500 : 2000);
          console.warn(`[Agent Runner ${label}] Gemini API ${status}. Emitting status event and retrying with backoff ${backoffMs}ms...`);
          onEvent({ type: 'status', text: 'Working…', message: 'Working…' });
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw apiErr;
      }
    }

    let accumulatedText = '';
    const calls: any[] = [];
    let modelContent: any = null;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of responseStream) {
      if (options.signal?.aborted) {
        break;
      }
      if (chunk.candidates?.[0]?.content) {
        modelContent = chunk.candidates[0].content;
      }
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
      }
      if (chunk.functionCalls && chunk.functionCalls.length > 0) {
        for (const fc of chunk.functionCalls) {
          calls.push(fc);
        }
      }
      if (chunk.text && streamTokens && calls.length === 0) {
        accumulatedText += chunk.text;
        onEvent({ type: 'token', content: chunk.text });
      } else if (chunk.text && !streamTokens) {
        accumulatedText += chunk.text;
      }
    }

    const durationMs = Math.round(performance.now() - callStart);
    console.log(
      `[Agent Runner ${label}] Model: ${modelName} | Duration: ${durationMs}ms | HTTP: ${httpStatus} | Retries: ${retryCount} | Thinking: ${JSON.stringify({ thinkingBudget: effectiveThinkingBudget })} | Tokens: ${inputTokens} in / ${outputTokens} out`
    );

    return {
      text: accumulatedText,
      functionCalls: calls,
      modelContent,
      durationMs
    };
  }

  let stageLlm1Ms = 0;
  let stageSearchMs = 0;
  let stageLlm2Ms = 0;
  let totalSearchCalls = 0;
  let finalAnswer = '';

  try {
    // ─── Turn 1: Search Dispatch (or direct answer if no-search) ───
    const intentResult = classifyIntent(userMessage, temporalRes);
    const turn1Mode = intentResult.firstTurnMode;

    console.log(
      `[Agent Runner Intent] Case chosen: ${intentResult.intent} (mode: ${turn1Mode}) [reason: ${intentResult.reason}]`
    );
    console.log(
      `[Agent Runner Turn 1] Function calling path: ${turn1Mode === FunctionCallingConfigMode.ANY ? 'FORCED (mode: ANY)' : turn1Mode === FunctionCallingConfigMode.NONE ? 'MEMORY ONLY (mode: NONE)' : 'AUTO (mode: AUTO)'} ` +
      `[intent: ${intentResult.intent}, reason: ${intentResult.reason}]`
    );

    const call1 = await executeGeminiCall({
      label: 'LLM call 1',
      mode: turn1Mode,
      allowedFunctionNames: turn1Mode === FunctionCallingConfigMode.NONE ? undefined : ['web_search'],
      streamTokens: true
    });

    stageLlm1Ms = call1.durationMs;

    if (options.signal?.aborted) {
      if (call1.text) {
        insertMessage(sessionId, 'assistant', call1.text, new Date().toISOString(), null, false, effectiveTz, effectiveUserId);
      }
      onEvent({ type: 'done' });
      return call1.text;
    }

    if (call1.functionCalls.length === 0) {
      // Direct text answer (no tool call was needed)
      finalAnswer = call1.text;
      console.log(`[Agent Runner Request ${sessionId}] Top 5 Search Results: none`);
    } else {
      // Model called web_search
      if (call1.modelContent) {
        contents.push(call1.modelContent);
      } else {
        contents.push({
          role: 'model',
          parts: call1.functionCalls.map((fc) => ({ functionCall: fc }))
        });
      }

      let turn1Results: WebSearchResultItem[] = [];
      let retryResults: WebSearchResultItem[] = [];
      const responseParts: any[] = [];
      const effectiveSearchStartDate = temporalRes.searchWindow?.startDate;

      for (const call of call1.functionCalls) {
        if (options.signal?.aborted) break;
        if (call.name === 'web_search') {
          totalSearchCalls++;
          const rawArgs = call.args as WebSearchArgs;
          const queries = Array.isArray(rawArgs?.queries) ? rawArgs.queries : [String(rawArgs?.queries || '')];
          onEvent({ type: 'tool_start', queries });

          const searchStart = performance.now();
          const results = options.mockSearchResults
            ? options.mockSearchResults
            : await executeWebSearch(
                rawArgs,
                Boolean(options.forceSequentialSearch),
                effectiveSearchStartDate,
                'basic' // Default 'basic' depth
              );
          const searchDur = Math.round(performance.now() - searchStart);
          stageSearchMs += searchDur;

          onEvent({
            type: 'tool_end',
            resultCount: results.length,
            durationMs: searchDur
          });

          onEvent({
            type: 'trace',
            step: 'search',
            queries: queries.length,
            results: results.length,
            ms: searchDur
          });

          turn1Results.push(...results);

          const funcResponseObj: any = {
            name: call.name,
            response: {
              results,
              note: TAVILY_PUBLISH_DATE_NOTE
            }
          };
          if (call.id) funcResponseObj.id = call.id;
          responseParts.push({ functionResponse: funcResponseObj });
        }
      }

      if (responseParts.length > 0) {
        contents.push({ role: 'user', parts: responseParts });
      }

      // Check if ONE extra search is allowed:
      // Zero results OR all results older than search window
      let allowExtraSearch = false;
      let extraSearchReason = '';

      if (turn1Results.length === 0) {
        allowExtraSearch = true;
        extraSearchReason = 'Turn 1 returned zero results';
      } else if (effectiveSearchStartDate) {
        const windowStart = effectiveSearchStartDate;
        const datedResults = turn1Results.filter((r) => Boolean(r.published_date));
        if (datedResults.length > 0 && datedResults.every((r) => r.published_date! < windowStart)) {
          allowExtraSearch = true;
          extraSearchReason = `All ${datedResults.length} dated results are older than search window startDate (${windowStart})`;
        }
      }

      // Execute allowed retry search if triggered and within hard cap of 2 calls
      if (allowExtraSearch && totalSearchCalls < 2) {
        console.log(`[Search Policy] Triggering allowed retry search: ${extraSearchReason}`);

        const retryCall = await executeGeminiCall({
          label: 'LLM call retry',
          mode: FunctionCallingConfigMode.AUTO,
          allowedFunctionNames: ['web_search'],
          streamTokens: false
        });

        if (retryCall.functionCalls.length > 0) {
          if (retryCall.modelContent) {
            contents.push(retryCall.modelContent);
          } else {
            contents.push({
              role: 'model',
              parts: retryCall.functionCalls.map((fc) => ({ functionCall: fc }))
            });
          }

          const retryResponseParts: any[] = [];
          for (const call of retryCall.functionCalls) {
            if (call.name === 'web_search') {
              totalSearchCalls++;
              const rawArgs = call.args as WebSearchArgs;
              const queries = Array.isArray(rawArgs?.queries) ? rawArgs.queries : [String(rawArgs?.queries || '')];
              onEvent({ type: 'tool_start', queries });

              const searchStart = performance.now();
              // Use 'advanced' search depth only on that one allowed retry
              const results = options.mockSearchResults
                ? options.mockSearchResults
                : await executeWebSearch(
                    rawArgs,
                    Boolean(options.forceSequentialSearch),
                    effectiveSearchStartDate,
                    'advanced'
                  );
              const searchDur = Math.round(performance.now() - searchStart);
              stageSearchMs += searchDur;

              onEvent({
                type: 'tool_end',
                resultCount: results.length,
                durationMs: searchDur
              });

              onEvent({
                type: 'trace',
                step: 'search',
                queries: queries.length,
                results: results.length,
                ms: searchDur
              });

              retryResults.push(...results);

              const funcResponseObj: any = {
                name: call.name,
                response: {
                  results,
                  note: TAVILY_PUBLISH_DATE_NOTE
                }
              };
              if (call.id) funcResponseObj.id = call.id;
              retryResponseParts.push({ functionResponse: funcResponseObj });
            }
          }

          if (retryResponseParts.length > 0) {
            contents.push({ role: 'user', parts: retryResponseParts });
          }
        }
      }

      // 6. Log top 5 search results with URL and published date
      const allSearchResults: WebSearchResultItem[] = [...turn1Results, ...retryResults];
      const top5 = allSearchResults.slice(0, 5);
      if (top5.length > 0) {
        const top5Log = top5
          .map((r, i) => `  ${i + 1}. [${r.published_date || 'No Date'}] ${r.url} - ${r.title}`)
          .join('\n');
        console.log(`[Agent Runner Request ${sessionId}] Top 5 Search Results:\n${top5Log}`);
      } else {
        console.log(`[Agent Runner Request ${sessionId}] Top 5 Search Results: none`);
      }

      if (options.signal?.aborted) {
        onEvent({ type: 'done' });
        return '';
      }

      // ─── Turn 2: Synthesis (toolConfig mode set to NONE) ───
      const synthesisCall = await executeGeminiCall({
        label: 'LLM call 2',
        mode: FunctionCallingConfigMode.NONE, // Must answer from results
        streamTokens: true // Streams 'token' SSE events as chunks arrive
      });

      stageLlm2Ms = synthesisCall.durationMs;
      finalAnswer = synthesisCall.text;

      if (options.signal?.aborted) {
        if (finalAnswer) {
          insertMessage(sessionId, 'assistant', finalAnswer, new Date().toISOString(), null, false, effectiveTz, effectiveUserId);
        }
        onEvent({ type: 'done' });
        return finalAnswer;
      }
    }

    if (!finalAnswer) {
      finalAnswer = 'Completed search verification with available context.';
      onEvent({ type: 'token', content: finalAnswer });
    }

    // Save final assistant response to SQLite
    insertMessage(sessionId, 'assistant', finalAnswer, new Date().toISOString(), null, false, effectiveTz, effectiveUserId);
    onEvent({ type: 'done' });

    // Print per-request stage breakdown
    const totalRequestMs = Math.round(performance.now() - requestStartTime);
    console.log(
      `[Agent Runner Stage Breakdown] Request ID: ${sessionId} | Pre-retrieval: ${preRetrievalDurationMs}ms | LLM call 1: ${stageLlm1Ms}ms | Search: ${stageSearchMs}ms | LLM call 2: ${stageLlm2Ms}ms | Total: ${totalRequestMs}ms`
    );

    return finalAnswer;

  } catch (error: any) {
    console.error('[Agent Runner Error]:', error);
    const errorMsg = simplifyErrorMessage(error);
    onEvent({ type: 'error', error: errorMsg });
    onEvent({ type: 'done' });
    return errorMsg;
  }
}

