# DESIGN.md — Temporal Chat Agent Architecture

## 1. Problem
A chat agent with one tool (`web_search`), evaluated on speed, correctness, and natural conversation.
The hard part is time: users refer to earlier chats and ask whether old answers are still right.
The agent must track past statements without confusing historical records with current live facts.

## 2. Architecture
```mermaid
flowchart LR
  Req[Request] --> Intent[Intent Check] --> Date[chrono-node Date Resolution] --> Mem[SQLite Date/FTS5] --> Model[Gemini Loop: web_search] --> SSE[Streamed Answer]
```
Memory is pre-retrieved and injected into the prompt before calling the model (`gemini-3.1-flash-lite`); it is not a tool, keeping the one-tool rule intact.
`web_search` uses default `'basic'` depth. The agent has a hard cap of 2 search calls: 1 initial call (forced for `VERIFY`, disabled for `RECALL`), and at most 1 retry at `'advanced'` depth if turn 1 returned 0 results or all dated results were older than the search window.

## 3. Key Decisions
1. **Memory pre-retrieval vs recall tool**: Code queries SQLite before the model turn. A recall tool was rejected because it would add a model round trip before every answer.
2. **SQLite date-range + FTS5 vs vector DB**: Embedded SQLite provides deterministic date filtering and BM25 text ranking without vector infrastructure complexity.
3. **Dates in code vs model date math**: Code uses `chrono-node` with the client's IANA timezone and an injectable clock. Model date math was rejected because it miscalculates midnight and week boundaries.
4. **Intent check for recall vs verify**: `classifyIntent` routes `RECALL` queries to tool mode `NONE` (0 searches) and `VERIFY` queries to tool mode `ANY` (forces 1 search). Pure `AUTO` was rejected because it over-searched on recall and failed to verify past claims online.
5. **Per-user scoping via signed cookie**: HMAC-SHA256 signed `user_id` cookie scopes all database queries (`user_id = ?`). Unscoped queries were rejected because they leak data across users.
6. **node:sqlite with FTS5 probe and fallback**: Built-in `node:sqlite` avoids native C++ compilation (`node-gyp`). It probes FTS5 in a temporary DB and falls back to multi-token `LIKE` search if unavailable.
7. **Batching multiple queries into one tool call**: `web_search` accepts an array `queries: string[]` executed concurrently via `Promise.all`. Batching avoids N sequential model turns (see reasoning in Section 5).

## 4. How It Stays Honest
- **Past conversations are not current facts**: Stored turns record what was said or claimed. Current facts (prices, versions) must come only from this turn's search results.
- **Retrieval returns user messages by default**: Assistant messages are excluded from keyword retrieval unless the user explicitly asks what the assistant said, preventing hallucination feedback loops.
- **No-record behavior**: If a date has no messages, the agent states it has no record for that date and reports the earliest stored date found by `getEarliestMessageDate(userId)`.
- **Citations and dates**: Links are placed on specific claim phrases using the source site name; answers prefer recent sources with explicit dates.
- **Search window in verify answers**: For verification queries, `searchWindow` starts at the anchor conversation date. If no updates appear, the answer explicitly states the window evaluated (e.g. "since [YYYY-MM-DD]") and that no published changes were found.

## 5. Performance
All numbers are cold runs (search cache cleared per request). Samples are small, so they are indicative only.

Single cold runs, n=2 each: an answer with no search took about 2.6 s total (2,666 ms and 2,557 ms). An answer with one search took about 4.2-4.5 s total (4,195 ms and 4,519 ms).

Parallel vs sequential search inside one tool call (same 3-CRM pricing prompt, n=5 each):

| | Search median (range) | TTFT median (range) | Total median (range) |
| :--- | :--- | :--- | :--- |
| Parallel | 613 ms (410-3,379) | 7,237 ms (4,291-9,320) | 9,885 ms (7,086-11,794) |
| Sequential | 922 ms (920-1,040) | 4,549 ms (4,170-5,846) | 7,281 ms (6,695-8,347) |

The search ranges overlap, so there is no reliable difference at the search stage. End to end, parallel was slower in this run. Parallel ran first and sequential second, so drifting Gemini latency may account for part of the gap. Both modes made one tool call. I did not benchmark the real alternative, one query per tool call (N model turns), so batching is chosen by reasoning (it avoids N model round trips), not by measurement.

Thinking budget (minimal vs default, n=2 each, different prompts): no measurable difference at this sample size.

Where the time goes: in the parallel vs sequential runs, search took about 0.4-3.4 s of 7-12 s total, so most of the time is model time.

## 6. Tests
- Tests cover date resolution, memory filtering, search policies (recall = 0, verify = 1, cap = 2), and grounding.
- Uses a fixed clock (`2026-11-12T12:00:00Z`), in-memory SQLite (`:memory:`) with a guard throwing if `data/chat.db` is opened, and mocked Gemini and Tavily (no API keys, zero network).
- Command: `npm test` (`tsx --test tests/*.test.ts`): 14 passing tests across 4 suites. Line count: 309 lines across 5 files under `tests/`.

## 7. Example Transcripts
1. **Empty DB date query**:
   - *User:* "What did I ask on 3 November?"
   - *Agent:* "I have no record of any conversation or questions from you on November 3, 2026. This user's earliest stored message is no stored history."
   - *Note:* Shows strict adherence to empty note reporting without inventing past discussions.
2. **Cross-session fact recall**:
   - *Chat 1 User:* "My favorite language is TypeScript." -> *Agent:* "I have noted that your favorite language is TypeScript."
   - *Chat 2 User:* "What is my favorite language?" -> *Agent:* "Based on our earlier conversation, your favorite language is TypeScript."
   - *Note:* Pre-retrieval injects historical user statements across sessions without calling search.
3. **Verify outdated statement**:
   - *User:* "Is your answer from yesterday about Node.js still correct?"
   - *Agent:* "Yesterday I stated Node.js 22.11.0 was current. Based on current search results, Node.js 26.13.0 (nodejs.org) is now released, so the earlier answer is outdated."
   - *Note:* Forces web search and treats past conversation as a historical claim to update rather than current truth.
4. **Pricing check with search window**:
   - *User:* "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
   - *Agent:* "Checking Postgres hosting with search window since 2026-11-10: Supabase Pro remains $25/mo and Neon is $0.106/CU-hour. No price changes were published in this window."
   - *Note:* Explicitly states the evaluated search window and reports absence of published changes.

## 8. Known Limitations
1. Keyword intent check can miss unusual phrasings (fallback is model's tool choice in `AUTO` mode).
2. Memory is message-level rather than structured claim-level.
3. Tavily filters by article publish date, so "no news found" does not prove that documentation did not change post-publish.
4. Snippets only: the agent does not fetch full web pages or execute dynamic client-side JS.
5. Single-node SQLite: `node:sqlite` relies on single-writer process file locks.
6. Latency depends on external Gemini API response times and rate limit quotas.

## 9. Next Steps
1. **Targeted page extraction**: Search snippets can miss embedded pricing tables. *First step:* call Tavily `/extract` on the top 2 result URLs when pricing details are ambiguous.
2. **Claim-level verification**: Extract specific claims (a version, a price) from an earlier answer and check each one. *First step:* store extracted claims alongside assistant messages.
