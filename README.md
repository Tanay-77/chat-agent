# High-Performance Chat Agent

A high-performance chat agent in TypeScript on Node.js featuring persistent SQLite memory, dynamic temporal context pre-retrieval, and batched parallel live web search.

---

## Core Components

### 1. SQLite Persistent Memory & Auto-Seeding (`src/db/`)
- **Store (`src/db/memory.ts`)**: `better-sqlite3` at `data/chat.db` with WAL mode enabled.
- **Indexes**: Indexed by `session_id`, `date_str` (`YYYY-MM-DD`), and `created_at`.
- **Dynamic Seeding (`src/db/seed.ts`)**: Automatically seeds 3 temporal conversations relative to `new Date()`:
  - **"3 November"**: Seeded on `${YYYY}-11-03T14:20:00Z` covering Next.js, Node.js LTS, and Claude 3.5 Sonnet token pricing.
  - **"Last Tuesday"**: Resolves the previous Tuesday (1–7 days ago), seeding Postgres hosting details (Supabase, Neon, AWS RDS, Render, Railway).
  - **"Monday"**: Resolves the most recent Monday (1–7 days ago), seeding a 20-person CRM shortlist (HubSpot, Pipedrive, Attio, Close, Folk).

### 2. Temporal Context Assembler (`src/context/temporalResolver.ts`)
- **Pre-Retrieval Pipeline**: Conversation memory retrieval happens before the LLM tool loop.
- Deterministically parses explicit dates ("3 November", "YYYY-MM-DD"), relative days ("Monday", "last Tuesday", "yesterday"), and entity keywords ("CRM", "Postgres", "shortlisted").
- Queries historical cross-session turns and formats them into a structured context block (`retrievedPastContext`) with exact timestamps and roles for system prompt injection.

### 3. Batched Parallel Web Search Tool (`src/tools/webSearch.ts`)
- Strictly ONE LLM tool: `web_search`.
- Accepts `queries: string[]` (1 to 6 concurrent queries executed via `Promise.all`), `topic?: 'general' | 'news'`, and `days_back?: number`.
- Connects to Tavily Search API with 8-second request timeout (`AbortController`), automatic retry, URL deduplication, and clean snippet extraction.

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment (`.env`)
```env
GEMINI_API_KEY=your_gemini_api_key_here
TAVILY_API_KEY=your_tavily_api_key_here
PORT=3000
```

### 3. Run Development Server
```bash
npm run dev
```

### 4. Run Test Suite
```bash
npm test
```
