# DESIGN.md — Temporal Chat Agent Architecture

## The Problem
Build an agent that tracks technical decisions across past sessions ("What did I ask on Nov 3?", "Did our CRM shortlist from Monday change pricing?") without hallucinating past turns.
**Core constraints:** Exactly one model-facing tool (`web_search`), no LLM date math, zero fabricated memories, and fast multi-entity search.

## Architecture Overview
```mermaid
flowchart TD
  Client[Client: React SPA] -->|POST /api/chat + Signed Cookie| Server[Express: Signed Cookie Auth]
  Server -->|1. Parse Dates & TZ| Resolver[chrono-node Temporal Resolver]
  Resolver -->|2. Scoped FTS5 BM25| SQLite[(SQLite: messages & FTS5)]
  Server -->|3. System Prompt + Injected Memory| Gemini[Gemini 2.5 / Flash-Lite]
  Gemini -->|4. web_search queries: []| Tavily[Tavily API: Promise.all Fan-out]
  Tavily -->|5. Snippets + URLs| Gemini
  Gemini -->|6. Temporal Diff + Citations| Client
```

## Decisions & Rejected Alternatives
1. **Deterministic Pre-Retrieval vs. Memory Tool**:
   - *Choice:* Query SQLite FTS5 in Node.js before the model turn; inject matched turns into the prompt.
   - *Rejected:* A `recall_memory` tool. Violated the single-tool constraint, added an LLM round-trip, and failed when the model miscalculated anchor dates.
2. **chrono-node + Client Timezone vs. LLM / Regex Date Math**:
   - *Choice:* Client passes IANA timezone (e.g. `Asia/Kolkata`); chrono-node anchors relative phrases ("last week", "yesterday") and resolves ambiguous dates (11/3 as DD/MM in India, MM/DD in US).
   - *Rejected:* Pure regex (brittle) or model arithmetic (frequently wrong across midnight and week boundaries).
3. **Batched Parallel Search (`queries: string[]`) vs. Sequential Calls**:
   - *Choice:* Single `web_search` declaration accepting 1–6 queries executed concurrently via `Promise.all` with URL deduplication.
   - *Rejected:* Single query per call. Comparing 5 CRMs sequentially took ~12s and 5 model turns.
4. **Signed httpOnly Cookie (`user_id`) vs. Unscoped Sessions**:
   - *Choice:* HMAC-SHA256 signed cookie with random UUID. All SQLite queries (`messages`, `messages_fts`) filter on `user_id = ?`, allowing cross-session recall only within that user.
   - *Rejected:* Global queries with `sessionId = null`, which leaked User B's conversations into User A's context.
5. **Deterministic First-Turn Tool Forcing on Change Words**:
   - *Choice:* If prompt contains change words (*changed*, *since*, *latest*, *pricing*) or past memory is retrieved, force function calling `mode: ANY` on turn 1.
   - *Rejected:* Pure `AUTO` mode, which sometimes answered from training weights without verifying online reality.
6. **Node's Built-in `node:sqlite` vs. Native Addon `better-sqlite3`**:
   - *Choice:* Use Node.js built-in `node:sqlite` (`DatabaseSync`).
   - *Why:* Zero native compilation step. `better-sqlite3` requires C++ compilation via `node-gyp` whenever prebuilt binaries are missing (e.g. newer Node releases or unsupported platform ABIs), which frequently fails on developer machines lacking Visual Studio C++ build tools. `node:sqlite` is bundled directly with Node.js (>= 22.13), ensuring `npm install` works instantly and identically on any operating system (Windows, macOS, Linux) with zero native dependencies.
   - *FTS5 Probing with Fallback:* At startup, a probe creates a virtual table in a disposable in-memory database (`:memory:`). If FTS5 is available, the system uses the full FTS5/BM25 ranking path. If FTS5 is unavailable in the host SQLite build, it logs one clear warning and gracefully falls back to a multi-token `LIKE` query over the same date range and `user_id` scope.

## Behavior When Memory Is Missing
When the database is empty or lacks matching historical context, prompt rules strictly forbid simulating prior discussions. The agent reports that no historical record exists for that date or topic and asks the user to provide context. It never invents past shortlists or questions.

## Measured Latency (bench/results.json)
Cold benchmark (search cache cleared per request, Gemini 3.1 Flash-Lite, 8 runs):
| Category | Runs | TTFT p50 | Total p50 | Search p50 | Tool Calls |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `no-search` | 2 | 21.4s | 21.6s | 2.36s | 1.0 |
| `single-search` | 2 | 23.5s | 23.7s | 3.61s | 1.0 |
| `multi-entity-search` | 2 | 14.6s | 16.2s | 1.73s | 1.0 |
| `follow-up` | 2 | 9.59s | 10.96s | 3.24s | 1.0 |
| **Overall Cold** | **8** | **19.5s** | **20.8s** | **2.36s** | **1.0 (0 fails)** |

- **Warm Suite** (search cache active): Overall TTFT p50: 4.85s | Total p50: 5.78s | Search p50: 2.15s.
- **Parallel vs Sequential** (5 cold runs each on 3-CRM comparison):
  - Parallel search: median 1,702 ms (range 1,600 – 1,745 ms)
  - Sequential search: median 2,033 ms (range 1,533 – 3,891 ms)

## Transcripts on Empty Database
1. **Prompt:** *"What did I ask you on 3 November? Is your answer still correct today?"*
   - **Response:** *"I have no record of any conversation or questions from you on 3 November 2026. My historical memory only contains the current interaction. Please share what you asked..."* (0 hallucinations).
2. **Prompt:** *"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?"*
   - **Response:** *"I have no record of a previous conversation or a CRM shortlist from this past Monday (November 9, 2026). Please provide the shortlist or specify which tools you'd like me to check..."*
3. **Prompt:** *"What is the current stable release version of Next.js?"*
   - **Response:** Dispatches `web_search(["Next.js current stable release version"])` and answers: *"The current stable release line is Next.js 16, with active patch releases (v16.4.x) and Next.js 15 in maintenance LTS."* (includes source links).

## Known Limitations
1. **Tavily publish-date filtering**: Tavily filters by original article publish date; pages updated or edited post-publish may be omitted from narrow date windows.
2. **Snippets-only content**: `web_search` receives search result text excerpts, not full rendered web pages or dynamic client-side JS content.
3. **Single-node SQLite**: `node:sqlite` uses synchronous file I/O with a single-writer lock; horizontal scaling requires an external database.

## Production Next Steps
1. **Vector Hybrid Search**: FTS5 BM25 misses conceptual synonyms ("cloud database" vs "managed Postgres").
   - *First step:* Add `sqlite-vec` embeddings with `text-embedding-004` and blend scores via Reciprocal Rank Fusion.
2. **Targeted Page Extraction**: Search snippets often miss pricing tables hidden in deep documentation.
   - *First step:* Call Tavily `/extract` on the top 2 ranked URLs when snippet confidence is low.
3. **PostgreSQL Migration**: SQLite lacks multi-instance concurrency.
   - *First step:* Swap `node:sqlite` for `pg` pool with schema migrations to support multi-container deployments.
