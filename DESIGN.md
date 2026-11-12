# DESIGN.md — Temporal Chat Agent Architecture

> A senior engineering document explaining the architectural decisions, pipeline design,
> and trade-offs in the Temporal Chat Agent system.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  CLIENT  (React SPA — SSE Consumer)                                             │
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────────────────────────────┐│
│  │  Sidebar      │  │  Chat Messages   │  │  Agent Trace Pills                 ││
│  │  - Timeline   │  │  - Markdown      │  │  - Retrieved dates from SQLite     ││
│  │  - Quick Test │  │  - Tables/Links  │  │  - Parallel web_search queries     ││
│  │  - Reset DB   │  │  - Live stream   │  │  - Result count + latency (ms)     ││
│  └──────────────┘  └──────────────────┘  └─────────────────────────────────────┘│
└────────────────────────────────────┬─────────────────────────────────────────────┘
                                     │
                          POST /api/chat (SSE Stream)
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│  EXPRESS SERVER  (src/index.ts)                                                  │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │  STEP 1: Pre-Retrieval Pipeline  (BEFORE the LLM runs)                     │ │
│  │  ┌──────────────────────────────────────────────────┐                      │ │
│  │  │  1a. Save user message → SQLite (messages table) │                      │ │
│  │  └──────────────────────────────────────────────────┘                      │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │  1b. resolveTemporalContext(userMessage, sessionId, now)            │  │ │
│  │  │      ┌──────────────────────────────────────────────────┐           │  │ │
│  │  │      │  Parse explicit dates:  "3 November" → 2026-11-03│           │  │ │
│  │  │      │  Parse relative days:   "Monday" → 2026-11-09    │           │  │ │
│  │  │      │  Parse entity keywords: "CRM", "Postgres"        │           │  │ │
│  │  │      └──────────────┬───────────────────────────────────┘           │  │ │
│  │  │                     │                                               │  │ │
│  │  │                     ▼                                               │  │ │
│  │  │      ┌──────────────────────────────────────────────────────────┐   │  │ │
│  │  │      │  SQLite Cross-Session Queries                           │   │  │ │
│  │  │      │  searchMessagesByDateRange(null, '2026-11-09', ...)     │   │  │ │
│  │  │      │  searchMessagesByKeyword(null, 'CRM')                   │   │  │ │
│  │  │      └──────────────┬───────────────────────────────────────────┘   │  │ │
│  │  │                     │                                               │  │ │
│  │  │                     ▼                                               │  │ │
│  │  │      ┌──────────────────────────────────────────────────┐           │  │ │
│  │  │      │  retrievedPastContext (formatted text block)      │           │  │ │
│  │  │      │  with timestamps, roles, and full message content │           │  │ │
│  │  │      └──────────────────────────────────────────────────┘           │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │  1c. Build System Prompt                                            │  │ │
│  │  │      - 14-day rolling calendar reference table                      │  │ │
│  │  │      - Injected retrievedPastContext                                │  │ │
│  │  │      - Operational rules (decompose, temporal-diff, cite)           │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │  STEP 2: Gemini ReAct Tool Loop  (max 4 iterations)                        │ │
│  │                                                                             │ │
│  │  ┌───────────────────────────┐                                             │ │
│  │  │  Gemini generateContent   │──── text tokens ──► SSE {type:'token'}       │ │
│  │  │  (streaming mode)         │                                             │ │
│  │  └──────────┬────────────────┘                                             │ │
│  │             │ functionCall: web_search                                      │ │
│  │             ▼                                                              │ │
│  │  ┌──────────────────────────────────────────────────────────────────────┐  │ │
│  │  │  BATCHED PARALLEL WEB SEARCH                                        │  │ │
│  │  │  queries: ["HubSpot pricing 2026", "Pipedrive pricing", ...]        │  │ │
│  │  │                                                                      │  │ │
│  │  │  Promise.all([                                                       │  │ │
│  │  │    fetchTavily("HubSpot pricing 2026"),  ─── 8s timeout each        │  │ │
│  │  │    fetchTavily("Pipedrive pricing"),      ─── AbortController       │  │ │
│  │  │    fetchTavily("Attio CRM pricing"),      ─── Retry on 5xx         │  │ │
│  │  │    fetchTavily("Close CRM plans"),                                   │  │ │
│  │  │    fetchTavily("Folk CRM pricing"),                                  │  │ │
│  │  │  ])                                                                  │  │ │
│  │  │           │                                                          │  │ │
│  │  │           ▼                                                          │  │ │
│  │  │  URL Deduplication → Clean results array                             │  │ │
│  │  └──────────────────────────────────────────────────────────────────────┘  │ │
│  │             │                                                              │ │
│  │             ▼                                                              │ │
│  │  ┌───────────────────────────────────────────────┐                        │ │
│  │  │  Temporal Diff Synthesis                       │                        │ │
│  │  │  Gemini compares:                              │                        │ │
│  │  │    Baseline (past convo) vs. Live (web search) │                        │ │
│  │  │  Generates markdown diff with citations        │                        │ │
│  │  └───────────────────────────────────────────────┘                        │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │  STEP 3: Post-Processing                                                   │ │
│  │  - Save assistant response → SQLite with ISO timestamp                     │ │
│  │  - Emit SSE {type:'done'} to client                                        │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐ │
│  │  DATA LAYER: SQLite (data/chat.db, WAL mode)                               │ │
│  │  ┌──────────────────────────────────────────┐                              │ │
│  │  │  messages                                │                              │ │
│  │  │  ├── id (PK, autoincrement)              │                              │ │
│  │  │  ├── session_id (indexed)                │                              │ │
│  │  │  ├── role ('user' | 'assistant')         │                              │ │
│  │  │  ├── content (TEXT)                      │                              │ │
│  │  │  ├── created_at (ISO 8601, indexed)      │                              │ │
│  │  │  ├── date_str (YYYY-MM-DD, indexed)      │                              │ │
│  │  │  └── keywords (comma-separated entities) │                              │ │
│  │  └──────────────────────────────────────────┘                              │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Design Decisions

### 1. Why Memory Is Pre-Retrieval, Not a Tool

The challenge imposes a strict constraint: **the LLM has exactly ONE tool — `web_search`**. No `recall_memory`, no `lookup_history`, no second tool.

The naive approach would be to make memory a second tool and hope the LLM calls it. This violates the rules. Even if it didn't, it introduces failure modes:

- The LLM might forget to call it, or call it with the wrong date.
- It adds an extra round-trip before the LLM can even begin reasoning about changes.
- LLMs are bad at date arithmetic. Given "last Tuesday," the model might hallucinate a wrong date and retrieve nothing.

**Our solution: deterministic pre-retrieval.** Before the LLM sees the prompt at all, Node.js code:

1. Parses temporal references (`"3 November"` → `2026-11-03`, `"Monday"` → `2026-11-09`) using regex and calendar math — zero LLM involvement.
2. Queries SQLite cross-session with exact date ranges and entity keywords.
3. Injects the matched historical turns directly into the system prompt as a structured `[RETRIEVED PAST CONVERSATION MEMORY]` block.

The LLM receives its context pre-assembled. It never needs to "decide" to look up memory. It just sees the past conversation alongside today's question and can immediately reason about what to verify via `web_search`.

**Result:** Zero extra LLM round-trips for memory, zero risk of wrong-date hallucination, and full compliance with the one-tool rule.

---

### 2. Solving the Multi-Entity Latency Trap

Consider the prompt: *"On Monday we shortlisted 5 CRM tools. Has any of them changed pricing?"*

A naive single-query search tool would force the LLM through this loop:

```
Turn 1:  web_search("HubSpot Sales Hub pricing")     ~2.4s
Turn 2:  web_search("Pipedrive pricing changes")      ~2.4s
Turn 3:  web_search("Attio CRM pricing")              ~2.4s
Turn 4:  web_search("Close CRM plans")                ~2.4s
Turn 5:  web_search("Folk CRM pricing")               ~2.4s
                                            Total: ~12s + 5 LLM round-trips
```

Five sequential tool calls. Five LLM round-trips just to dispatch searches. The user waits 12+ seconds before the model can even begin synthesizing.

**Our solution: batched array queries.**

The `web_search` tool accepts `queries: string[]` — an array of 1 to 6 search strings. Under the hood, `executeWebSearch` fires them all concurrently via `Promise.all()`:

```
Turn 1:  web_search({
           queries: [
             "HubSpot Sales Hub pricing 2026",
             "Pipedrive pricing changes",
             "Attio CRM pricing",
             "Close CRM plans",
             "Folk CRM pricing"
           ],
           days_back: 7
         })
                                 ──► Promise.all() ──► ~1.2s total, 1 LLM round-trip
```

**Gains:**
- **Latency**: 5 sequential requests (~12s) → 1 parallel fan-out (~1.2s). **10× faster.**
- **LLM Round-Trips**: 5 → 1. Each round-trip costs ~800ms of model inference time.
- **URL Deduplication**: If multiple queries return the same page (e.g., a vendor's pricing page), we deduplicate by URL so the LLM doesn't process redundant content.

Each individual Tavily request has an **8-second `AbortController` timeout** so one slow provider can never hang the entire fan-out.

---

### 3. Deterministic Relative Date Grounding

LLMs are unreliable at date arithmetic. Ask GPT-4 or Gemini "What date was last Tuesday?" on a Thursday, and you'll get wrong answers ~20-30% of the time. The model doesn't have a reliable internal calendar.

**Our solution: inject a 14-day rolling calendar lookup table** directly into the system prompt.

```
TODAY: Thursday, Nov 12, 2026 (2026-11-12 12:00 UTC)
RELATIVE CALENDAR MAPPING (Past 14 Days Reference):
- 2026-11-12 (Thursday, Nov 12) [TODAY]
- 2026-11-11 (Wednesday, Nov 11) [YESTERDAY]
- 2026-11-10 (Tuesday, Nov 10) [2 days ago]
- 2026-11-09 (Monday, Nov 9) [3 days ago]
- 2026-11-08 (Sunday, Nov 8) [4 days ago]
- 2026-11-07 (Saturday, Nov 7) [5 days ago]
- 2026-11-06 (Friday, Nov 6) [6 days ago]
- 2026-11-05 (Thursday, Nov 5) [7 days ago]
- 2026-11-04 (Wednesday, Nov 4) [8 days ago]
- 2026-11-03 (Tuesday, Nov 3) [9 days ago]
  ...
```

Now when the user asks "Last Tuesday I asked about Postgres hosting," the LLM doesn't need to compute anything. It looks at the table, sees `2026-11-10 (Tuesday) [2 days ago]`, and correctly references the historical data retrieved for that date. Meanwhile, our pre-retrieval pipeline already resolved `"last Tuesday"` → `2026-11-10` deterministically in Node.js and fetched the matching turns.

The LLM and the pre-retrieval code agree on the same dates because they both derive from the same `new Date()` reference point.

---

### 4. Dynamic Seed Dates: Why They're Relative

The seeded conversations use **relative date calculations**, not hardcoded dates:

- `"3 November"`: Uses the most recent November 3rd strictly in the past relative to `new Date()`.
- `"Last Tuesday"`: Computes `(currentDayOfWeek - 2 + 7) % 7` with `diff === 0 ? 7 : diff`.
- `"Monday"`: Computes `(currentDayOfWeek - 1 + 7) % 7` with the same zero-guard.

This means if an evaluator runs the app on December 1st, the seeded "last Tuesday" conversation lands on November 25th (not a stale October date). The temporal resolver's regex-based parser uses the same arithmetic, so the two always agree.

---

### 5. SSE Streaming & Agent Trace

The frontend consumes `POST /api/chat` as a Server-Sent Events stream. Each SSE frame is a JSON object:

| Event Type    | Payload                                          | Purpose                                  |
|--------------|--------------------------------------------------|------------------------------------------|
| `status`     | `{ message: "Retrieved memory from Nov 9..." }`  | Pre-retrieval progress indicator         |
| `tool_start` | `{ queries: ["HubSpot pricing 2026", ...] }`     | Shows which searches were dispatched     |
| `tool_end`   | `{ resultCount: 15, durationMs: 820 }`           | Search completion + latency measurement  |
| `token`      | `{ content: "Based on the current..." }`         | Streamed model output (incremental text) |
| `error`      | `{ error: "Rate limit exceeded" }`               | Error reporting                          |
| `done`       | `{}`                                             | Stream termination signal                |

The frontend accumulates `status`, `tool_start`, `tool_end`, and `error` events into an **Agent Trace** array. This is displayed as a collapsible pill above each assistant reply, showing the full retrieval-search-synthesis pipeline at a glance.

---

## Trade-offs & Production Next Steps

### Current Limitations

1. **Keyword-based memory search**: The current `searchMessagesByKeyword` uses SQLite `LIKE '%keyword%'` — linear scan, no semantic understanding. "database hosting" won't match a message about "Postgres hosting" unless "Postgres" or "hosting" appears literally.

2. **Static entity keyword list**: The `CANDIDATE_KEYWORDS` array in `temporalResolver.ts` is manually curated. New topics discussed in future sessions won't be automatically detected unless the keyword list is expanded.

3. **No JS-rendered page scraping**: Tavily returns snippets, not full page content. If a vendor updates pricing only on a JavaScript-heavy interactive page (no static text), the search results may not capture the change.

4. **Single-node SQLite**: `better-sqlite3` is synchronous and single-writer. Fine for a single-server challenge, but won't scale to concurrent multi-instance deployments.

### Production Enhancements

1. **SQLite FTS5 + Vector Hybrid Memory**:
   - Add a `messages_fts` virtual table using SQLite FTS5 for full-text search with BM25 ranking.
   - For semantic recall ("that database conversation"), embed messages with a lightweight model (e.g., `text-embedding-004`) and store vectors in a `message_embeddings` table. At query time, combine FTS5 keyword hits with cosine-similarity vector results in a hybrid ranker.

2. **Automatic Keyword Extraction**:
   - Replace the static keyword list with lightweight NER/keyphrase extraction (e.g., `compromise` NLP library or a small Gemini call) at message insertion time. Store extracted entities in the `keywords` column automatically.

3. **Adaptive Page Scraping**:
   - For high-value pricing URLs detected in search results, dispatch a secondary headless fetch (or Tavily `extract` endpoint) to pull the full rendered page content, then pass it as additional context to the LLM for more accurate diff analysis.

4. **Rate-Limit Backoff & Circuit Breaker**:
   - Add exponential backoff with jitter on Tavily 429 responses.
   - Implement a circuit breaker pattern: after N consecutive failures to a provider, skip it for M seconds and return cached/stale results with a staleness warning.

5. **Persistent Session Management**:
   - Add a `sessions` table with metadata (created_at, last_active, title, tags).
   - Support session branching: "Continue the CRM discussion from Monday in a new thread."

6. **PostgreSQL Migration for Multi-Instance**:
   - Replace SQLite with PostgreSQL + `pgvector` for production horizontal scaling.
   - Use connection pooling (e.g., `pg-pool`) and read replicas for history queries.

