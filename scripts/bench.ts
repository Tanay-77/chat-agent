import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import dotenv from 'dotenv';
import { seedDatabase } from '../src/db/seed.js';

dotenv.config();

export interface BenchmarkPrompt {
  id: string;
  category: 'no-search' | 'single-search' | 'multi-entity-search' | 'follow-up';
  prompt: string;
  sessionId: string;
  expectSearch: boolean;
  forceSequentialSearch?: boolean;
}

export interface BenchmarkMetric {
  id: string;
  category: 'no-search' | 'single-search' | 'multi-entity-search' | 'follow-up';
  prompt: string;
  sessionId: string;
  expectSearch: boolean;
  forceSequentialSearch: boolean;
  timeToFirstTokenMs: number | null;
  timeToDoneMs: number;
  toolCallsCount: number;
  searchDurationMs: number;
  citationsCount: number;
  tokensCount: number;
  answerText: string;
  status: 'OK' | 'FAIL' | 'ERROR';
  error?: string;
}

export interface CategorySummary {
  category: string;
  count: number;
  ttftP50Ms: number;
  ttftP95Ms: number;
  doneP50Ms: number;
  doneP95Ms: number;
  searchP50Ms: number;
  searchP95Ms: number;
  avgToolCalls: number;
  failedExpectations: number;
}

export interface RunOptions {
  forceSequential?: boolean;
  thinkingBudget?: number;
  isCold?: boolean;
}

const SERVER_PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${SERVER_PORT}`;

// 8 benchmark prompts (2 per category)
export const BENCHMARK_PROMPTS: BenchmarkPrompt[] = [
  // ----------------------------------------------------
  // Category 1: no-search (small talk / static knowledge, expectSearch: false)
  // ----------------------------------------------------
  {
    id: 'no-search-01',
    category: 'no-search',
    prompt: 'Hello! Can you briefly introduce yourself and what you specialize in?',
    sessionId: 'bench-no-search-01',
    expectSearch: false
  },
  {
    id: 'no-search-02',
    category: 'no-search',
    prompt: 'Explain the difference between synchronous and asynchronous code in JavaScript in two clear sentences.',
    sessionId: 'bench-no-search-02',
    expectSearch: false
  },

  // ----------------------------------------------------
  // Category 2: single-search (lookup single live facts/versions/pricing, expectSearch: true)
  // ----------------------------------------------------
  {
    id: 'single-search-01',
    category: 'single-search',
    prompt: 'What is the current stable release version of Next.js?',
    sessionId: 'bench-single-01',
    expectSearch: true
  },
  {
    id: 'single-search-02',
    category: 'single-search',
    prompt: 'Who is the current CEO of Microsoft and when did they take office?',
    sessionId: 'bench-single-02',
    expectSearch: true
  },

  // ----------------------------------------------------
  // Category 3: multi-entity-search (cross-verify multi-vendor pricing/plans, expectSearch: true)
  // ----------------------------------------------------
  {
    id: 'multi-search-01',
    category: 'multi-entity-search',
    prompt: 'Compare current pricing and plans for HubSpot Sales Hub, Pipedrive, and Close CRM tools.',
    sessionId: 'bench-multi-01',
    expectSearch: true
  },
  {
    id: 'multi-search-02',
    category: 'multi-entity-search',
    prompt: 'Compare the current 2026 pricing and entry tiers across Supabase, Neon, and AWS RDS for managed Postgres.',
    sessionId: 'bench-multi-02',
    expectSearch: true
  },

  // ----------------------------------------------------
  // Category 4: follow-up (anchoring to historical conversation turns)
  // ----------------------------------------------------
  {
    id: 'follow-up-01',
    category: 'follow-up',
    prompt: 'What did I ask you on 3 November? Is your answer still correct today?',
    sessionId: 'session-nov3-versions',
    expectSearch: true // contains 'still', 'today' -> verifies live accuracy
  },
  {
    id: 'follow-up-02',
    category: 'follow-up',
    prompt: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    sessionId: 'session-tuesday-postgres',
    expectSearch: true // contains 'changed', 'since' -> verifies changes
  }
];

export const SPEEDUP_PROMPT: BenchmarkPrompt = {
  id: 'speedup-eval',
  category: 'multi-entity-search',
  prompt: 'Compare current pricing and plans for HubSpot Sales Hub, Pipedrive, and Close CRM tools for a sales team.',
  sessionId: 'bench-speedup-session',
  expectSearch: true
};

/**
 * Counts unique URL and markdown citations in text.
 */
export function countCitations(text: string): number {
  if (!text) return 0;
  const urls = new Set<string>();

  // Markdown links: [Title](url)
  const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdRegex.exec(text)) !== null) {
    urls.add(match[2]);
  }

  // Bare URLs
  const bareRegex = /https?:\/\/[^\s)\]>"']+/g;
  while ((match = bareRegex.exec(text)) !== null) {
    urls.add(match[0]);
  }

  return urls.size;
}

/**
 * Clears the in-memory search cache on the server.
 */
export async function clearServerCache(): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    await fetch(`${SERVER_URL}/api/cache/clear`, {
      method: 'POST',
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch {
    // Ignore cache clear error if server is not responding yet
  }
}

/**
 * Checks server health.
 */
export async function checkServerHealth(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${SERVER_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensures server is running.
 */
export async function ensureServerRunning(): Promise<{ process: ChildProcess | null; startedHere: boolean }> {
  const isHealthy = await checkServerHealth();
  if (isHealthy) {
    console.log(`[Benchmark] Server already running at ${SERVER_URL} (healthy).`);
    return { process: null, startedHere: false };
  }

  console.log(`[Benchmark] No active server detected at ${SERVER_URL}. Launching background server...`);
  const tsxCliPath = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const child = fs.existsSync(tsxCliPath)
    ? spawn(process.execPath, [tsxCliPath, 'src/index.ts'], {
        stdio: 'inherit',
        env: { ...process.env, PORT: String(SERVER_PORT) }
      })
    : spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/index.ts'], {
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, PORT: String(SERVER_PORT) }
      });

  const maxAttempts = 30;
  for (let i = 1; i <= maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const ok = await checkServerHealth();
    if (ok) {
      console.log(`[Benchmark] Server successfully booted at ${SERVER_URL} (took ${i}s).`);
      return { process: child, startedHere: true };
    }
  }

  child.kill();
  throw new Error(`Failed to start server at ${SERVER_URL} after 30 seconds.`);
}

/**
 * Computes percentile from a numeric array.
 */
export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

/**
 * Sends a single prompt to POST /api/chat and records metrics.
 */
export async function sendChatRequest(
  promptItem: BenchmarkPrompt,
  options: RunOptions = {}
): Promise<BenchmarkMetric> {
  const { forceSequential = false, thinkingBudget, isCold = false } = options;

  if (isCold) {
    await clearServerCache();
  }

  const startWallTime = performance.now();
  let firstTokenTime: number | null = null;
  let toolCallsCount = 0;
  let totalSearchDurationMs = 0;
  let totalCharacters = 0;
  let answerContent = '';
  let errorMsg: string | undefined;

  try {
    const payload: Record<string, any> = {
      message: promptItem.prompt,
      sessionId: promptItem.sessionId,
      forceSequentialSearch: forceSequential
    };
    if (typeof thinkingBudget === 'number') {
      payload.thinkingBudget = thinkingBudget;
    }

    const response = await fetch(`${SERVER_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} from /api/chat: ${errText}`);
    }

    if (!response.body) {
      throw new Error('No readable response stream received from /api/chat');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processSseLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) return;
      const jsonPayload = trimmed.slice(6).trim();
      if (jsonPayload === '[DONE]') return;

      try {
        const event = JSON.parse(jsonPayload);
        if (event.type === 'token') {
          if (firstTokenTime === null) {
            firstTokenTime = performance.now() - startWallTime;
          }
          if (event.content) {
            totalCharacters += event.content.length;
            answerContent += event.content;
          }
        } else if (event.type === 'tool_start') {
          toolCallsCount++;
        } else if (event.type === 'tool_end') {
          if (typeof event.durationMs === 'number') {
            totalSearchDurationMs += event.durationMs;
          }
        } else if (event.type === 'error') {
          errorMsg = event.error || 'Server reported error event';
        }
      } catch {
        // Ignore non-json
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) processSseLine(buffer.trim());
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        processSseLine(line);
      }
    }
  } catch (err: any) {
    errorMsg = err.message || 'Stream processing failed';
  }

  const endWallTime = performance.now();
  const totalDurationMs = Math.round(endWallTime - startWallTime);
  const citationsCount = countCitations(answerContent);

  // Validation: Check expectSearch vs toolCallsCount
  let status: 'OK' | 'FAIL' | 'ERROR' = 'OK';
  if (errorMsg) {
    status = 'ERROR';
  } else if (promptItem.expectSearch && toolCallsCount === 0) {
    status = 'FAIL';
  }

  return {
    id: promptItem.id,
    category: promptItem.category,
    prompt: promptItem.prompt,
    sessionId: promptItem.sessionId,
    expectSearch: promptItem.expectSearch,
    forceSequentialSearch: forceSequential,
    timeToFirstTokenMs: firstTokenTime !== null ? Math.round(firstTokenTime) : null,
    timeToDoneMs: totalDurationMs,
    toolCallsCount,
    searchDurationMs: Math.round(totalSearchDurationMs),
    citationsCount,
    tokensCount: totalCharacters,
    answerText: answerContent,
    status,
    error: errorMsg
  };
}

/**
 * Summarizes a category of benchmark runs.
 */
export function summarizeCategory(category: string, metrics: BenchmarkMetric[]): CategorySummary {
  const count = metrics.length;
  const ttftValues = metrics.map((m) => m.timeToFirstTokenMs ?? m.timeToDoneMs);
  const doneValues = metrics.map((m) => m.timeToDoneMs);
  const searchValues = metrics.map((m) => m.searchDurationMs);
  const totalTools = metrics.reduce((acc, m) => acc + m.toolCallsCount, 0);
  const failedCount = metrics.filter((m) => m.status === 'FAIL').length;

  return {
    category,
    count,
    ttftP50Ms: calculatePercentile(ttftValues, 50),
    ttftP95Ms: calculatePercentile(ttftValues, 95),
    doneP50Ms: calculatePercentile(doneValues, 50),
    doneP95Ms: calculatePercentile(doneValues, 95),
    searchP50Ms: calculatePercentile(searchValues, 50),
    searchP95Ms: calculatePercentile(searchValues, 95),
    avgToolCalls: count > 0 ? Number((totalTools / count).toFixed(2)) : 0,
    failedExpectations: failedCount
  };
}

/**
 * Formats and prints a clean ASCII table.
 */
export function printTable(headers: string[], rows: (string | number)[][]): void {
  const colWidths = headers.map((h, i) => {
    const maxVal = Math.max(...rows.map((r) => String(r[i] ?? '').length), h.length);
    return Math.max(maxVal + 2, 8);
  });

  const sepLine = '+' + colWidths.map((w) => '-'.repeat(w)).join('+') + '+';
  const headerLine = '|' + headers.map((h, i) => ` ${h}`.padEnd(colWidths[i])).join('|') + '|';

  console.log(sepLine);
  console.log(headerLine);
  console.log(sepLine);

  for (const row of rows) {
    const rowLine = '|' + row.map((cell, i) => ` ${cell}`.padEnd(colWidths[i])).join('|') + '|';
    console.log(rowLine);
  }

  console.log(sepLine);
}

/**
 * Executes a full suite of prompts, logging quality preview and reporting stats.
 */
async function executePromptSuite(
  prompts: BenchmarkPrompt[],
  options: RunOptions,
  suiteLabel: string
): Promise<{ metrics: BenchmarkMetric[]; summary: CategorySummary[]; overall: CategorySummary }> {
  console.log(`\n========================================================================`);
  console.log(`          RUNNING ${suiteLabel.toUpperCase()} (${prompts.length} PROMPTS)`);
  console.log(`========================================================================\n`);

  const metrics: BenchmarkMetric[] = [];
  const categories: BenchmarkPrompt['category'][] = [
    'no-search',
    'single-search',
    'multi-entity-search',
    'follow-up'
  ];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const indexStr = `[${String(i + 1).padStart(2, '0')}/${prompts.length}]`;
    const tag = `(${p.category})`;

    const m = await sendChatRequest(p, options);
    metrics.push(m);

    const statusTag = m.status === 'OK' ? '✓ OK' : m.status === 'FAIL' ? '✗ FAIL' : '! ERR';
    const preview = m.answerText.slice(0, 140).replace(/\s+/g, ' ');

    console.log(`${indexStr} ${tag} ${statusTag} | Tools: ${m.toolCallsCount} (exp: ${p.expectSearch ? 1 : 0}) | TTFT: ${m.timeToFirstTokenMs ?? '-'}ms | Done: ${m.timeToDoneMs}ms | Citations: ${m.citationsCount}`);
    console.log(`      Preview: "${preview}..."`);

    await new Promise((r) => setTimeout(r, 1200));
  }

  const categorySummaries = categories.map((cat) => {
    return summarizeCategory(cat, metrics.filter((m) => m.category === cat));
  });
  const overallSummary = summarizeCategory(`OVERALL (${suiteLabel})`, metrics);

  const tableHeaders = [
    'Category',
    'Count',
    'TTFT p50',
    'TTFT p95',
    'Done p50',
    'Done p95',
    'Search p50',
    'Search p95',
    'Avg Tools',
    'Status'
  ];

  const tableRows: (string | number)[][] = [
    ...categorySummaries.map((s) => [
      s.category,
      s.count,
      `${s.ttftP50Ms} ms`,
      `${s.ttftP95Ms} ms`,
      `${s.doneP50Ms} ms`,
      `${s.doneP95Ms} ms`,
      `${s.searchP50Ms} ms`,
      `${s.searchP95Ms} ms`,
      s.avgToolCalls,
      s.failedExpectations === 0 ? 'ALL PASS' : `${s.failedExpectations} FAIL`
    ]),
    [
      overallSummary.category,
      overallSummary.count,
      `${overallSummary.ttftP50Ms} ms`,
      `${overallSummary.ttftP95Ms} ms`,
      `${overallSummary.doneP50Ms} ms`,
      `${overallSummary.doneP95Ms} ms`,
      `${overallSummary.searchP50Ms} ms`,
      `${overallSummary.searchP95Ms} ms`,
      overallSummary.avgToolCalls,
      overallSummary.failedExpectations === 0 ? 'ALL PASS' : `${overallSummary.failedExpectations} FAIL`
    ]
  ];

  console.log(`\n--- ${suiteLabel} Summary Table (p50 / p95) ---`);
  printTable(tableHeaders, tableRows);

  return { metrics, summary: categorySummaries, overall: overallSummary };
}

async function runBenchmark(): Promise<void> {
  console.log('========================================================================');
  console.log('            TEMPORAL AGENT BENCHMARK & REGRESSION SUITE                ');
  console.log('========================================================================');

  let serverInstance: ChildProcess | null = null;
  let startedHere = false;

  try {
    const serverSetup = await ensureServerRunning();
    serverInstance = serverSetup.process;
    startedHere = serverSetup.startedHere;

    if (serverInstance) {
      process.on('SIGINT', () => {
        serverInstance?.kill();
        process.exit(130);
      });
      process.on('SIGTERM', () => {
        serverInstance?.kill();
        process.exit(143);
      });
    }

    // Ensure database has canonical baseline data for follow-up prompts
    seedDatabase(false);

    // ----------------------------------------------------
    // 1. Run COLD Suite (default: clears search cache before every request)
    // ----------------------------------------------------
    const coldResults = await executePromptSuite(
      BENCHMARK_PROMPTS,
      { isCold: true },
      'Cold Suite (Cache Cleared Per Request)'
    );

    // ----------------------------------------------------
    // 2. Run WARM Suite (retains search cache to evaluate warm speedup)
    // ----------------------------------------------------
    const warmResults = await executePromptSuite(
      BENCHMARK_PROMPTS,
      { isCold: false },
      'Warm Suite (In-Memory Cache Active)'
    );

    // ----------------------------------------------------
    // 3. Parallel vs Sequential Search Comparison (Cold-Only, 5 Runs Each)
    // ----------------------------------------------------
    console.log('\n========================================================================');
    console.log('   COLD PARALLEL vs SEQUENTIAL SEARCH COMPARISON (5 RUNS EACH)          ');
    console.log('========================================================================');
    console.log(`Prompt: "${SPEEDUP_PROMPT.prompt}"\n`);

    const NUM_SPEEDUP_RUNS = 5;
    const parallelRuns: BenchmarkMetric[] = [];
    const sequentialRuns: BenchmarkMetric[] = [];

    console.log(`Running ${NUM_SPEEDUP_RUNS} cold runs with PARALLEL batched search (Promise.all)...`);
    for (let r = 1; r <= NUM_SPEEDUP_RUNS; r++) {
      const metric = await sendChatRequest(
        { ...SPEEDUP_PROMPT, sessionId: `bench-speedup-par-${r}` },
        { forceSequential: false, isCold: true }
      );
      parallelRuns.push(metric);
      console.log(`  Run ${r}: Done: ${metric.timeToDoneMs}ms | Search: ${metric.searchDurationMs}ms | TTFT: ${metric.timeToFirstTokenMs}ms | Tools: ${metric.toolCallsCount}`);
      await new Promise((res) => setTimeout(res, 500));
    }

    console.log(`\nRunning ${NUM_SPEEDUP_RUNS} cold runs with FORCED SEQUENTIAL search...`);
    for (let r = 1; r <= NUM_SPEEDUP_RUNS; r++) {
      const metric = await sendChatRequest(
        { ...SPEEDUP_PROMPT, sessionId: `bench-speedup-seq-${r}` },
        { forceSequential: true, isCold: true }
      );
      sequentialRuns.push(metric);
      console.log(`  Run ${r}: Done: ${metric.timeToDoneMs}ms | Search: ${metric.searchDurationMs}ms | TTFT: ${metric.timeToFirstTokenMs}ms | Tools: ${metric.toolCallsCount}`);
      await new Promise((res) => setTimeout(res, 500));
    }

    // Helper for median and range min-max
    const getMedianAndRange = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const median = calculatePercentile(sorted, 50);
      const min = sorted[0];
      const max = sorted[sorted.length - 1];
      return { median, min, max, str: `${median} ms (${min} - ${max} ms)` };
    };

    const parSearch = getMedianAndRange(parallelRuns.map((r) => r.searchDurationMs));
    const seqSearch = getMedianAndRange(sequentialRuns.map((r) => r.searchDurationMs));

    const parTtft = getMedianAndRange(parallelRuns.map((r) => r.timeToFirstTokenMs ?? r.timeToDoneMs));
    const seqTtft = getMedianAndRange(sequentialRuns.map((r) => r.timeToFirstTokenMs ?? r.timeToDoneMs));

    const parDone = getMedianAndRange(parallelRuns.map((r) => r.timeToDoneMs));
    const seqDone = getMedianAndRange(sequentialRuns.map((r) => r.timeToDoneMs));

    const searchSpeedupRatio = parSearch.median > 0 ? (seqSearch.median / parSearch.median).toFixed(2) : 'N/A';
    const ttftSpeedupRatio = parTtft.median > 0 ? (seqTtft.median / parTtft.median).toFixed(2) : 'N/A';
    const doneSpeedupRatio = parDone.median > 0 ? (seqDone.median / parDone.median).toFixed(2) : 'N/A';

    const speedupHeaders = ['Metric', 'Parallel (5 Cold Runs)', 'Sequential (5 Cold Runs)', 'Median Speedup'];
    const speedupRows = [
      ['Search Duration (tool_end)', parSearch.str, seqSearch.str, `${searchSpeedupRatio}x faster`],
      ['Time to First Token (TTFT)', parTtft.str, seqTtft.str, `${ttftSpeedupRatio}x faster`],
      ['Total Time to Done', parDone.str, seqDone.str, `${doneSpeedupRatio}x faster`],
      ['Tool Calls Dispatched', '1 tool call', '1 tool call', 'Identical parity']
    ];

    printTable(speedupHeaders, speedupRows);

    // ----------------------------------------------------
    // 4. Thinking Budget Comparison: Minimal (budget=1) vs Previous (Default)
    // ----------------------------------------------------
    console.log('\n========================================================================');
    console.log('   THINKING BUDGET: MINIMAL (budget: 1) vs PREVIOUS (DEFAULT)           ');
    console.log('========================================================================\n');

    // Compare on 2 representative cold queries (1 no-search, 1 search)
    const thinkingTestPrompts: BenchmarkPrompt[] = [
      BENCHMARK_PROMPTS[0], // no-search
      BENCHMARK_PROMPTS[2]  // single-search
    ];

    console.log('A. Testing Minimal Thinking Budget (thinkingBudget: 1, cold)...');
    const minimalThinkingMetrics: BenchmarkMetric[] = [];
    for (const p of thinkingTestPrompts) {
      const m = await sendChatRequest(p, { isCold: true, thinkingBudget: 1 });
      minimalThinkingMetrics.push(m);
      console.log(`   [budget: 1] (${p.category}) Done: ${m.timeToDoneMs}ms | TTFT: ${m.timeToFirstTokenMs}ms | Tools: ${m.toolCallsCount}`);
      await new Promise((res) => setTimeout(res, 400));
    }

    console.log('\nB. Testing Previous Setting (Default / Unrestricted thinking, cold)...');
    const defaultThinkingMetrics: BenchmarkMetric[] = [];
    for (const p of thinkingTestPrompts) {
      const m = await sendChatRequest(p, { isCold: true, thinkingBudget: undefined });
      defaultThinkingMetrics.push(m);
      console.log(`   [default]   (${p.category}) Done: ${m.timeToDoneMs}ms | TTFT: ${m.timeToFirstTokenMs}ms | Tools: ${m.toolCallsCount}`);
      await new Promise((res) => setTimeout(res, 400));
    }

    const minDoneMedian = calculatePercentile(minimalThinkingMetrics.map((m) => m.timeToDoneMs), 50);
    const defDoneMedian = calculatePercentile(defaultThinkingMetrics.map((m) => m.timeToDoneMs), 50);
    const minTtftMedian = calculatePercentile(minimalThinkingMetrics.map((m) => m.timeToFirstTokenMs ?? m.timeToDoneMs), 50);
    const defTtftMedian = calculatePercentile(defaultThinkingMetrics.map((m) => m.timeToFirstTokenMs ?? m.timeToDoneMs), 50);
    const minTools = minimalThinkingMetrics.reduce((a, m) => a + m.toolCallsCount, 0);
    const defTools = defaultThinkingMetrics.reduce((a, m) => a + m.toolCallsCount, 0);

    const thinkingHeaders = ['Configuration', 'Median TTFT', 'Median Done Time', 'Total Tool Calls'];
    const thinkingRows = [
      ['Minimal Budget (thinkingBudget: 1)', `${minTtftMedian} ms`, `${minDoneMedian} ms`, `${minTools} calls`],
      ['Previous Setting (Default Budget)', `${defTtftMedian} ms`, `${defDoneMedian} ms`, `${defTools} calls`]
    ];

    printTable(thinkingHeaders, thinkingRows);

    // ----------------------------------------------------
    // Save Final Results to bench/results.json
    // ----------------------------------------------------
    const benchDir = path.resolve(process.cwd(), 'bench');
    if (!fs.existsSync(benchDir)) {
      fs.mkdirSync(benchDir, { recursive: true });
    }

    const outputPayload = {
      timestamp: new Date().toISOString(),
      serverUrl: SERVER_URL,
      coldSuite: {
        summary: coldResults.overall,
        categories: coldResults.summary,
        runs: coldResults.metrics
      },
      warmSuite: {
        summary: warmResults.overall,
        categories: warmResults.summary,
        runs: warmResults.metrics
      },
      parallelVsSequentialCold: {
        prompt: SPEEDUP_PROMPT.prompt,
        numRunsEach: NUM_SPEEDUP_RUNS,
        parallel: {
          searchDurationMs: parSearch,
          ttftMs: parTtft,
          doneMs: parDone,
          runs: parallelRuns
        },
        sequential: {
          searchDurationMs: seqSearch,
          ttftMs: seqTtft,
          doneMs: seqDone,
          runs: sequentialRuns
        },
        speedup: {
          searchDurationSpeedup: `${searchSpeedupRatio}x`,
          ttftSpeedup: `${ttftSpeedupRatio}x`,
          doneSpeedup: `${doneSpeedupRatio}x`
        }
      },
      thinkingBudgetComparison: {
        minimalBudget: {
          budget: 1,
          medianTtftMs: minTtftMedian,
          medianDoneMs: minDoneMedian,
          totalTools: minTools,
          runs: minimalThinkingMetrics
        },
        defaultBudget: {
          budget: 'default',
          medianTtftMs: defTtftMedian,
          medianDoneMs: defDoneMedian,
          totalTools: defTools,
          runs: defaultThinkingMetrics
        }
      }
    };

    const outPath = path.join(benchDir, 'results.json');
    fs.writeFileSync(outPath, JSON.stringify(outputPayload, null, 2), 'utf-8');
    console.log(`\n✓ Full benchmark results saved to: ${path.relative(process.cwd(), outPath)}`);
    console.log('========================================================================\n');
  } finally {
    if (startedHere && serverInstance) {
      console.log('[Benchmark] Shutting down spawned server process...');
      serverInstance.kill();
    }
  }
}

runBenchmark().catch((err) => {
  console.error('\n[Benchmark Error]:', err);
  process.exit(1);
});
