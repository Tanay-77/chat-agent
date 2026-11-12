# High-Performance Chat Agent (Stage 1)

Stage 1 implementation of a high-performance, temporal-aware chat agent built with TypeScript, Node.js, Express, and SQLite (`better-sqlite3`).

---

## Features (Stage 1)

1. **Persistent SQLite Memory Layer (`src/db/memory.ts`)**:
   - Stores all messages in `data/chat.db` with WAL mode enabled for high-throughput reads and concurrent writes.
   - `messages` table schema:
     - `id`: Auto-incrementing primary key
     - `session_id`: Unique identifier per conversation thread
     - `role`: `'user' | 'assistant'`
     - `content`: Full message text
     - `created_at`: ISO 8601 timestamp string
     - `date_str`: `YYYY-MM-DD` indexed column for fast date filtering
     - `keywords`: Comma-separated entities for semantic/entity search
   - Core query helpers:
     - `insertMessage(sessionId, role, content, createdAt?, keywords?)`
     - `getRecentMessages(sessionId, limit = 15)`
     - `searchMessagesByDateRange(sessionId, startDateStr, endDateStr)`
     - `searchMessagesByKeyword(sessionId, keyword)`

2. **Dynamic Auto-Seeding (`src/db/seed.ts`)**:
   - Automatically executes on server startup if `data/chat.db` is empty.
   - Dynamically calculates dates relative to `new Date()` so temporal references remain accurate regardless of when the evaluator runs the application:
     - **"3 November"**: Seeded on `${YYYY}-11-03T14:20:00Z` covering Next.js 15.0.1, Node.js v22.11.0 LTS, and Claude 3.5 Sonnet token pricing.
     - **"Last Tuesday"**: Dynamically resolves the previous Tuesday (1–7 days prior), seeding detailed hosting specs & pricing across Supabase, Neon, AWS RDS, Render, and Railway.
     - **"Monday"**: Dynamically resolves the most recent Monday (1–7 days prior), seeding a 20-person sales team shortlist for HubSpot, Pipedrive, Attio, Close, and Folk with per-seat pricing and features.

3. **Server & Health Endpoints (`src/server.ts`)**:
   - Express server on `PORT` (default 3000).
   - `/health`: Inspect uptime and live SQLite database stats.
   - `/api/messages`: Query messages by date range, keyword, or session.
   - `/api/seed`: Re-seed database on demand.

---

## Setup & Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Ensure `.env` contains:
```env
GROQ_API_KEY=
OPENAI_API_KEY=
TAVILY_API_KEY=
PORT=3000
```

### 3. Run Development Server
```bash
npm run dev
```

### 4. Run Memory Tests & Verification
```bash
npm test
```

