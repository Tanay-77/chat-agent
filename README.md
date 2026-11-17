# High-Performance Chat Agent

A high-performance chat agent in TypeScript on Node.js featuring persistent SQLite memory, dynamic temporal context pre-retrieval, batched parallel live web search, and a real-time SSE streaming agent loop powered by Google Gemini.

---

## Prerequisites
- **Node.js**: `>= 22.13.0` (uses Node's built-in `node:sqlite` module — zero native C++ compiler or `node-gyp` required).

---

## Core Components

### 1. SQLite Persistent Memory & Explicit Demo Seeding (`src/db/`)
- **Store (`src/db/memory.ts`)**: Node's built-in `node:sqlite` (`DatabaseSync`) at `data/chat.db` with WAL mode enabled. No native build dependencies or C++ toolchains (`node-gyp`, Visual Studio) required; installs cleanly and identically across any OS.
- **Indexes**: Indexed by `session_id`, `date_str` (`YYYY-MM-DD`), `created_at`, and `is_demo`.
- **FTS5 Virtual Table (`messages_fts`) & Fallback**: Probes for SQLite FTS5 extension support at startup in a disposable in-memory database. When available, uses SQLite FTS5 index over message content with triggers and BM25 relevance ranking. If FTS5 is not compiled into the host SQLite build, it logs a clear warning and seamlessly falls back to a multi-token `LIKE` search over the same date range and `user_id` scope.
- **Empty Startup**: A fresh database starts completely empty on boot. No fabricated conversations are seeded automatically.
- **Explicit Demo Seeding (`src/db/seed.ts` / `npm run seed:demo`)**: Demo conversations are moved behind an explicit CLI command and clearly tagged in SQLite with `is_demo = 1` (normal live turns use `is_demo = 0`):
  - **"3 November"**: Seeded on `${YYYY}-11-03T14:20:00Z` covering Next.js 15.0.1, Node.js v22.11.0 LTS, and Claude 3.5 Sonnet token pricing.
  - **"Last Tuesday"**: Resolves the previous Tuesday (1–7 days ago), seeding Postgres hosting details across Supabase, Neon, AWS RDS, Render, and Railway.
  - **"Monday"**: Resolves the most recent Monday (1–7 days ago), seeding a 20-person sales team CRM shortlist (HubSpot, Pipedrive, Attio, Close, Folk).

### 2. Pre-Retrieval Temporal Context Assembler (`src/context/temporalResolver.ts`)
- **Strictly ONE LLM Tool Rule**: Memory retrieval executes in a deterministic pre-retrieval pipeline **before** the LLM loop.
- **FTS5 BM25 + Date-Range Retrieval**: Combines date-range filtering with SQLite FTS5 BM25 relevance ranking over sanitized user terms — completely replacing static keyword lists and linear `LIKE '%keyword%'` scans.
- **Context Budget Capping**: Injected context is prioritized by date relevance and BM25 score, capped to a strict character budget (`MAX_CONTEXT_CHARS`), and formatted with explicit timestamps (`YYYY-MM-DD HH:mm:ss UTC`) for system prompt injection.

### 3. Batched Parallel Web Search Tool (`src/tools/webSearch.ts`)
- Strictly ONE LLM tool: `web_search`.
- Accepts `queries: string[]` (1 to 6 concurrent queries executed concurrently via `Promise.all`), `topic?: 'general' | 'news'`, and `days_back?: number`.
- Connects to Tavily Search API with 8-second request timeout (`AbortController`), retry logic, URL deduplication, and clean snippet extraction.

### 4. Agent Loop & SSE Streaming API (`src/agent/runner.ts`, `src/index.ts`)
- **Agent Loop (`src/agent/runner.ts`)**:
  - Uses `@google/genai` (default: `gemini-3.1-flash-lite`, configurable via `MODEL_NAME`).
  - Automatically persists user and assistant messages in SQLite.
  - Generates a 14-day relative calendar mapping in the system prompt so the LLM anchors dates accurately.
  - **Strict Anti-Fabrication Rule**: If the user refers to a past conversation, question, or shortlist and no matching history was retrieved from SQLite, the agent explicitly states that it has no record of it and asks for details. The agent is strictly prohibited from inventing prior conversation turns.
  - Executes a multi-turn tool calling loop (up to 4 iterations) emitting real-time event callbacks:
    - `{ type: 'status', message: '...' }`
    - `{ type: 'tool_start', queries: [...] }`
    - `{ type: 'tool_end', resultCount: ..., durationMs: ... }`
    - `{ type: 'token', content: '...' }` (live streamed answer tokens)
    - `{ type: 'done' }`
- **Streaming Endpoints (`src/index.ts`)**:
  - `POST /api/chat`: Streams real-time updates and response tokens via Server-Sent Events (`text/event-stream`).
  - `GET /api/history?sessionId=`: Returns conversation history with turns grouped by date (`groupedByDate`) and active session list.
  - `POST /api/reset`: Clears SQLite memory to a completely empty DB state (0 messages).
  - `GET /health`: Inspects live database stats (total messages, demo count, sessions), uptime, and configured model.

---

## Example prompts

1. **Evaluation Prompt 1 · CRM Shortlist**:
   > "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"

2. **Evaluation Prompt 2 · 3 November Versions**:
   > "What did I ask you on 3 November? Is your answer still correct today?"

3. **Evaluation Prompt 3 · Postgres Hosting**:
   > "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment (`.env`)
```env
GEMINI_API_KEY=your_gemini_api_key_here
MODEL_NAME=gemini-3.1-flash-lite
TAVILY_API_KEY=your_tavily_api_key_here
PORT=3000
```

### 3. (Optional) Populate Demo Conversations
By default, the database boots completely empty. To populate the benchmark demo conversations (3 November versions, Last Tuesday Postgres, Monday CRM):
```bash
npm run seed:demo
```

### 4. Run Development Server
```bash
npm run dev
```

### 5. Run Test Suite
```bash
npm test
```

### 6. Build for Production
```bash
npm run build
npm start
```
