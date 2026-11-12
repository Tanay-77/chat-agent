import dotenv from 'dotenv';
dotenv.config();

import { GoogleGenAI } from '@google/genai';
import {
  insertMessage,
  getRecentMessages,
  Message
} from '../db/memory.js';
import { resolveTemporalContext } from '../context/temporalResolver.js';
import {
  webSearchToolDeclaration,
  executeWebSearch,
  WebSearchArgs
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
 * Builds a 14-day relative calendar mapping from the perspective of `now`.
 */
export function buildCalendarReference(now: Date = new Date()): string {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const lines: string[] = [];
  const currentDayName = dayNames[now.getDay()];
  const currentMonthName = monthNames[now.getMonth()];
  const currentDateStr = now.toISOString().slice(0, 10);
  const currentTimeStr = now.toISOString().slice(11, 16);

  lines.push(`TODAY: ${currentDayName}, ${currentMonthName} ${now.getDate()}, ${now.getFullYear()} (${currentDateStr} ${currentTimeStr} UTC)`);
  lines.push('RELATIVE CALENDAR MAPPING (Past 14 Days Reference):');

  for (let i = 0; i <= 14; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dayName = dayNames[d.getDay()];
    const mName = monthNames[d.getMonth()];
    const dateStr = d.toISOString().slice(0, 10);
    const label = i === 0 ? '[TODAY]' : i === 1 ? '[YESTERDAY]' : `[${i} days ago]`;
    lines.push(`- ${dateStr} (${dayName}, ${mName} ${d.getDate()}) ${label}`);
  }

  return lines.join('\n');
}

/**
 * Constructs the system prompt with calendar anchors, retrieved historical memory, and operational rules.
 */
export function buildSystemPrompt(now: Date, pastContext: string): string {
  const calendarRef = buildCalendarReference(now);

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
     * Current Live Reality: What live web results show as of today (${now.toISOString().slice(0, 10)}).
     * Diff Analysis: Explicitly detail what changed (price increases/decreases, new tiers, limits) and what remains identical.
     * Be precise with numbers, tiers, and specs.

4. FACTUAL CITATIONS & TONE:
   - Ground every live factual claim with markdown citations: \`[Source Title](url)\`.
   - If web search confirms no changes have occurred, state explicitly: "Pricing and limits for [Provider] remain unchanged since [Date] based on current official documentation [Source](url)."
   - Maintain a concise, authoritative, professional, and well-structured response using Markdown tables or bullet points.`;
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
  refDate: Date = new Date()
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const errorMsg = 'GEMINI_API_KEY is not configured in environment.';
    onEvent({ type: 'error', error: errorMsg });
    onEvent({ type: 'token', content: `Configuration Error: ${errorMsg}` });
    onEvent({ type: 'done' });
    return errorMsg;
  }

  const modelName = process.env.MODEL_NAME || 'gemini-3.5-flash-lite';
  const now = refDate;
  const isoNow = now.toISOString();

  // 1. Save incoming user message to SQLite
  insertMessage(sessionId, 'user', userMessage, isoNow);

  // 2. Pre-Retrieval Context Resolution (before LLM call)
  const temporalRes = resolveTemporalContext(userMessage, sessionId, now);
  if (temporalRes.matchedMessages.length > 0) {
    const datesDesc = temporalRes.detectedDates.length > 0
      ? temporalRes.detectedDates.join(', ')
      : 'cross-session history';
    onEvent({
      type: 'status',
      message: `Retrieved historical memory (${temporalRes.matchedMessages.length} turns matched for ${datesDesc})`
    });
  }

  // 3. Assemble System Prompt & Conversation History
  const systemPrompt = buildSystemPrompt(now, temporalRes.formattedContext);

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

  let finalAnswer = '';
  const maxIterations = 4;
  let iteration = 0;

  try {
    while (iteration < maxIterations) {
      iteration++;

      // Request stream from Gemini
      const responseStream = await ai.models.generateContentStream({
        model: modelName,
        contents,
        config: {
          systemInstruction: systemPrompt,
          tools: [{
            functionDeclarations: [webSearchToolDeclaration]
          }],
          temperature: 0.2
        }
      });

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
            const searchResults = await executeWebSearch(rawArgs);
            const durationMs = Date.now() - startTime;

            onEvent({
              type: 'tool_end',
              resultCount: searchResults.length,
              durationMs
            });

            const funcResponseObj: any = {
              name: call.name,
              response: {
                results: searchResults
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

    // 4. Save final assistant response to SQLite
    insertMessage(sessionId, 'assistant', finalAnswer, new Date().toISOString());
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

