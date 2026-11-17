# Chat Agent

A chat agent with one tool (web search) and persistent, date-aware memory of earlier chats.
It stores conversations in SQLite and pre-retrieves relevant past turns before calling the model.

## Requirements

- Node.js >= 22.13 (uses built-in `node:sqlite`, no native compiler required). Tested on Node v24.13.0.
- `GEMINI_API_KEY`: Required. Get from Google AI Studio (https://aistudio.google.com).
- `MODEL_NAME`: Optional. Model name (defaults to `gemini-3.1-flash-lite`).
- `TAVILY_API_KEY`: Required for web search. Get from Tavily (https://tavily.com).
- `PORT`: Optional. HTTP server port (defaults to `3000`).

## Run it

1. `npm install`
2. Copy `.env.example` to `.env` and add your API keys.
3. `npm run dev`
4. Open the printed URL (http://localhost:3000).

The client bundle builds automatically on `npm run dev` via `predev`. The SQLite database starts completely empty (`data/chat.db`).

## Try it

- Tell it a fact, then ask in a new chat: send "My favorite color is navy blue", click New Chat, then ask "What is my favorite color?".
- "What did I ask on 3 November?" on an empty DB (answers that it has no record of that date).
- "What is the current stable release version of Next.js?" (runs web search for current live version).
- "What did I ask on 3 November? Is your answer still correct today?" (retrieves memory turn and searches web to verify).
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" (retrieves Tuesday memory and compares current pricing).

## Commands

- `npm run dev`: Builds client bundle and starts the development server with file watching.
- `npm run build`: Bundles the client (`src/client/build.ts`) and compiles TypeScript (`tsc`).
- `npm test`: Runs test suite (`node:test`) against an in-memory database with mocked APIs.
- `npm run bench`: Runs latency benchmark suite across all categories and saves metrics to `benchmark/results.json`.
- `npm run seed:demo`: Populates SQLite with baseline demo sessions (optional, never runs automatically).

## Project layout

- `src/agent/`: Agent runner, intent routing, and tool-calling loop.
- `src/context/`: Date resolution (`chrono-node`) and pre-retrieval memory filtering.
- `src/db/`: SQLite connection (`node:sqlite`), schema, and demo seed script.
- `src/tools/`: Tavily web search tool with concurrent query execution.
- `src/client/`: React frontend client and esbuild bundle script.
- `tests/`: Node test runner suites for dates, memory, policy, and sessions.
- `scripts/`: Benchmark runner and latency evaluation scripts.
- `bench/`: Benchmark markdown summaries and raw output data.

## More

See [DESIGN.md](file:///c:/Tanay%20Programing/chat%20agent/DESIGN.md) for architecture, prompt design, and latency benchmarks.
Known limitations (Tavily publish dates, snippet-only text, and single-writer SQLite) are documented in [DESIGN.md#known-limitations](file:///c:/Tanay%20Programing/chat%20agent/DESIGN.md#known-limitations).
