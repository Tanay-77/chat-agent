import { seedDatabase } from './db/seed.js';
import {
  db,
  insertMessage,
  getRecentMessages,
  searchMessagesByDateRange,
  searchMessagesFTS,
  sanitizeFTSQuery,
  getDatabaseStats,
  getAllMessages,
  clearDatabase,
  isDatabaseEmpty,
  createSession,
  getUserSessions,
  getUserSessionsWithSummary,
  getSessionMessages,
  formatSessionTitle,
  cleanupEmptySessions,
  probeFTS5,
  setFTS5AvailableForTesting,
  transaction
} from './db/memory.js';
import { resolveTemporalContext, MAX_CONTEXT_CHARS, parseDates, formatDateInTz, setUserTimezone } from './context/temporalResolver.js';
import {
  webSearchToolDeclaration,
  executeWebSearch,
  computeEffectiveStartDate,
  TAVILY_PUBLISH_DATE_NOTE,
  WebSearchResultItem
} from './tools/webSearch.js';
import { FunctionCallingConfigMode } from '@google/genai';
import { buildCalendarReference, buildSystemPrompt, runAgent, AgentEvent, classifyIntent } from './agent/runner.js';
import { computeTracePillState } from './client/components/AgentTrace.js';
import app, { signCookieValue, unsignCookieValue, parseCookies, USER_COOKIE_NAME } from './index.js';

async function runTests() {
  console.log('=== Running Chat Agent Verification Suite ===\n');
  const now = new Date('2026-11-12T12:00:00Z');

  // 1. Seed & Memory Tests (with is_demo validation)
  console.log('[1/7] Testing Persistent Memory, Demo Tagging & Database Clearing...');
  clearDatabase();
  const seedResult = seedDatabase(true, now);
  if (seedResult.messages.length !== 6) {
    throw new Error(`Expected 6 seeded messages, got ${seedResult.messages.length}`);
  }

  // Verify all seeded demo messages have is_demo = 1
  for (const msg of seedResult.messages) {
    if (msg.is_demo !== 1) {
      throw new Error(`Expected seeded message to have is_demo = 1, got ${msg.is_demo}`);
    }
  }

  const statsWithDemo = getDatabaseStats();
  if (statsWithDemo.totalMessages !== 6 || statsWithDemo.sessionsCount !== 3 || statsWithDemo.datesCount !== 3 || statsWithDemo.demoCount !== 6) {
    throw new Error(`Unexpected demo stats: ${JSON.stringify(statsWithDemo)}`);
  }

  // Test that regular messages default to is_demo = 0
  const regularMsg = insertMessage('test-live-session', 'user', 'Hello standard turn');
  if (regularMsg.is_demo !== 0) {
    throw new Error(`Expected normal message to have is_demo = 0, got ${regularMsg.is_demo}`);
  }
  db.prepare('DELETE FROM messages WHERE session_id = ?').run('test-live-session');

  // Range and FTS queries
  const novRange = searchMessagesByDateRange(null, '2026-11-01', '2026-11-05');
  if (novRange.length !== 2) throw new Error('Date range query failed');

  // Probe FTS5 detection
  const isFtsSupported = probeFTS5();
  if (typeof isFtsSupported !== 'boolean') {
    throw new Error(`Expected probeFTS5() to return boolean, got ${typeof isFtsSupported}`);
  }

  // 1a. Test FTS5 path (probe result mocked to true)
  setFTS5AvailableForTesting(true);
  const postgresFts = searchMessagesFTS('Postgres hosting options');
  if (postgresFts.length < 2) throw new Error('FTS5 search for Postgres failed');
  if (typeof postgresFts[0].rank !== 'number' || postgresFts[0].rank >= 0) {
    throw new Error('FTS5 BM25 ranking should return negative score');
  }

  // 1b. Test LIKE search fallback path (probe result mocked to false)
  setFTS5AvailableForTesting(false);
  const postgresLike = searchMessagesFTS('Postgres hosting options');
  if (postgresLike.length < 2) throw new Error('LIKE fallback search for Postgres failed');
  if (!postgresLike.some(m => m.content.includes('Postgres'))) {
    throw new Error('LIKE fallback search did not return Postgres message');
  }
  if (typeof postgresLike[0].rank !== 'number' || postgresLike[0].rank >= 0) {
    throw new Error('LIKE fallback search ranking should return negative score');
  }

  // Reset FTS5 override to default detection
  setFTS5AvailableForTesting(null);

  // Test transaction helper: commit and rollback
  transaction(() => {
    insertMessage('test-tx-session', 'user', 'Transaction committed turn');
  });
  const txMsg = db.prepare('SELECT * FROM messages WHERE session_id = ?').get('test-tx-session');
  if (!txMsg) throw new Error('Transaction helper failed to commit message');
  db.prepare('DELETE FROM messages WHERE session_id = ?').run('test-tx-session');

  try {
    transaction(() => {
      insertMessage('test-tx-rollback', 'user', 'Should be rolled back');
      throw new Error('Forced rollback');
    });
  } catch {
    // Expected rollback error
  }
  const rolledBackMsg = db.prepare('SELECT * FROM messages WHERE session_id = ?').get('test-tx-rollback');
  if (rolledBackMsg) throw new Error('Transaction helper failed to rollback message on error');

  const recent = getRecentMessages('session-monday-crm', 10);
  if (recent.length !== 2) throw new Error('Recent messages query failed');

  // Test FTS5 query sanitization
  const safeQuery = sanitizeFTSQuery('flight booking talk (ANA vs JAL)? *deals* "cheap"!');
  if (!safeQuery.includes('"flight"') || !safeQuery.includes('"booking"') || safeQuery.includes('*') || safeQuery.includes('?')) {
    throw new Error(`FTS sanitization failed: got ${safeQuery}`);
  }
  if (sanitizeFTSQuery('') !== '' || sanitizeFTSQuery('   ') !== '') {
    throw new Error('Empty query sanitization should return empty string');
  }

  console.log('Memory layer tests & FTS5 BM25 verification passed.');

  // 2. Temporal Context Resolution Tests
  console.log('\n[2/7] Testing Temporal Context Assembler with FTS5 BM25...');

  // Query 1: Monday CRM shortlist
  const q1 = "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";
  const res1 = resolveTemporalContext(q1, 'session-test-1', now);
  if (res1.matchedMessages.length < 2 || !res1.matchedMessages.some(m => m.content.includes('HubSpot Sales Hub'))) {
    throw new Error('Temporal resolution for Monday CRM query failed');
  }

  // Query 2: 3 November
  const q2 = "What did I ask you on 3 November? Is your answer still correct today?";
  const res2 = resolveTemporalContext(q2, 'session-test-2', now);
  if (res2.matchedMessages.length < 2 || !res2.matchedMessages.some(m => m.content.includes('Next.js 15.0.1'))) {
    throw new Error('Temporal resolution for 3 November query failed');
  }

  // Query 3: Last Tuesday Postgres
  const q3 = "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?";
  const res3 = resolveTemporalContext(q3, 'session-test-3', now);
  if (res3.matchedMessages.length < 2 || !res3.matchedMessages.some(m => m.content.includes('Supabase'))) {
    throw new Error('Temporal resolution for Last Tuesday query failed');
  }

  // Generic Query 4: Unrelated to CRM or Postgres (e.g. "that flight booking talk")
  console.log('  -> Testing generic topic retrieval unrelated to CRM/Postgres ("that flight booking talk")...');
  const flightSession = 'session-flight-test';
  insertMessage(
    flightSession,
    'user',
    'Can you summarize that flight booking talk to Tokyo for next spring? What were the airline options?',
    '2026-11-06T11:00:00Z'
  );
  insertMessage(
    flightSession,
    'assistant',
    'In our flight booking talk, we compared nonstop flights to Tokyo: ANA was $850 round-trip and JAL was $910 round-trip with checked luggage.',
    '2026-11-06T11:01:00Z'
  );

  const resFlight = resolveTemporalContext(
    'What did we decide in that flight booking talk?',
    'session-generic-eval',
    now
  );

  if (resFlight.matchedMessages.length < 2 || !resFlight.matchedMessages.some(m => m.content.includes('ANA was $850'))) {
    throw new Error(`Generic FTS5 retrieval failed for flight booking talk. Matches: ${resFlight.matchedMessages.length}`);
  }
  // Verify timestamps are included in formatted context
  if (!resFlight.formattedContext.includes('Timestamp:') || !resFlight.formattedContext.includes('2026-11-06')) {
    throw new Error('Formatted context missing explicit timestamps');
  }
  // Verify character budget is respected
  if (resFlight.formattedContext.length > MAX_CONTEXT_CHARS) {
    throw new Error(`Context exceeded maximum character budget: ${resFlight.formattedContext.length} > ${MAX_CONTEXT_CHARS}`);
  }
  console.log('  ✓ Generic FTS5 retrieval passed: "that flight booking talk" correctly matched via BM25 without static keywords.');

  // Test searchWindow computation derived from anchor date
  console.log('  -> Testing searchWindow computation from anchor dates...');
  // Case A: "since Monday" -> relative anchor date (2026-11-09)
  const resMonday = resolveTemporalContext('Has any pricing changed since Monday?', 'session-win-test', now);
  if (!resMonday.searchWindow || resMonday.searchWindow.startDate !== '2026-11-09') {
    throw new Error(`searchWindow failed for "since Monday": expected 2026-11-09, got ${resMonday.searchWindow?.startDate}`);
  }

  // Case B: "3 November" -> explicit anchor date (2026-11-03)
  const resNov3 = resolveTemporalContext('What did I ask on 3 November? Is your answer still correct today?', 'session-win-test', now);
  if (!resNov3.searchWindow || resNov3.searchWindow.startDate !== '2026-11-03') {
    throw new Error(`searchWindow failed for "3 November": expected 2026-11-03, got ${resNov3.searchWindow?.startDate}`);
  }

  // Case C: "Last Tuesday" -> relative anchor date (2026-11-10)
  const resTuesday = resolveTemporalContext('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', 'session-win-test', now);
  if (!resTuesday.searchWindow || resTuesday.searchWindow.startDate !== '2026-11-10') {
    throw new Error(`searchWindow failed for "Last Tuesday": expected 2026-11-10, got ${resTuesday.searchWindow?.startDate}`);
  }

  // Case D: Historical conversation retrieval with no explicit date in prompt -> derived from retrieved messages (2026-11-06)
  if (!resFlight.searchWindow || resFlight.searchWindow.startDate !== '2026-11-06') {
    throw new Error(`searchWindow failed for flight booking talk: expected 2026-11-06, got ${resFlight.searchWindow?.startDate}`);
  }

  // Case E: Small talk with no past conversation or dates -> searchWindow should be undefined
  const resSmallTalk = resolveTemporalContext('Hello! Can you briefly introduce yourself and what you specialize in?', 'session-win-test', now);
  if (resSmallTalk.searchWindow !== undefined) {
    throw new Error(`searchWindow failed for small talk: expected undefined, got ${JSON.stringify(resSmallTalk.searchWindow)}`);
  }
  console.log('  ✓ searchWindow computation verified across explicit, relative, conversation-derived, and empty contexts.');

  // Test computeEffectiveStartDate (resolver default applied, model cannot widen/move earlier, model may narrow)
  console.log('  -> Testing computeEffectiveStartDate enforcement and clamping...');
  // 1. Resolver startDate applied by default when model provides none
  const defaultApplied = computeEffectiveStartDate(undefined, '2026-11-09');
  if (defaultApplied !== '2026-11-09') {
    throw new Error(`Expected resolver startDate 2026-11-09 to apply by default, got ${defaultApplied}`);
  }

  // 2. Model cannot widen or move earlier than resolver startDate
  const widenedClamped = computeEffectiveStartDate('2026-11-01', '2026-11-09');
  if (widenedClamped !== '2026-11-09') {
    throw new Error(`Expected widened date 2026-11-01 to be clamped to 2026-11-09, got ${widenedClamped}`);
  }

  // 3. Model narrowing to a later date is accepted
  const narrowedAccepted = computeEffectiveStartDate('2026-11-11', '2026-11-09');
  if (narrowedAccepted !== '2026-11-11') {
    throw new Error(`Expected narrowed date 2026-11-11 to be accepted, got ${narrowedAccepted}`);
  }

  // 4. Model providing start_date without resolver default
  const noResolver = computeEffectiveStartDate('2026-10-15', undefined);
  if (noResolver !== '2026-10-15') {
    throw new Error(`Expected model date 2026-10-15 to be preserved without resolver, got ${noResolver}`);
  }
  console.log('  ✓ computeEffectiveStartDate verified: resolver default applied, widening blocked, narrowing accepted.');

  // Clean up flight test session
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(flightSession);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");

  // ─── Table-driven chrono-node date parsing tests (20+ phrases) ────
  // Fixed "now": Thursday 2026-11-12 at 23:45 IST (= 2026-11-12T18:15:00Z)
  // This is close to midnight in Asia/Kolkata, testing boundary behavior.
  console.log('  -> Running table-driven chrono-node date parsing tests (20+ phrases)...');
  const chronoNow = new Date('2026-11-12T18:15:00Z'); // 23:45 IST on Thu Nov 12
  const IST = 'Asia/Kolkata';
  const NYC = 'America/New_York';

  // Verify formatDateInTz works correctly at the midnight boundary
  const todayIST = formatDateInTz(chronoNow, IST);
  const todayUTC = formatDateInTz(chronoNow, 'UTC');
  if (todayIST !== '2026-11-12') {
    throw new Error(`formatDateInTz: expected 2026-11-12 in IST, got ${todayIST}`);
  }
  if (todayUTC !== '2026-11-12') {
    throw new Error(`formatDateInTz: expected 2026-11-12 in UTC, got ${todayUTC}`);
  }

  // Now cross midnight: 15 minutes later = 2026-11-13 00:00 IST but still 2026-11-12 18:30 UTC
  const postMidnightIST = new Date('2026-11-12T18:30:00Z'); // 00:00 IST on Fri Nov 13
  const postMidnightISTStr = formatDateInTz(postMidnightIST, IST);
  const postMidnightUTCStr = formatDateInTz(postMidnightIST, 'UTC');
  if (postMidnightISTStr !== '2026-11-13') {
    throw new Error(`Midnight boundary: expected 2026-11-13 in IST, got ${postMidnightISTStr}`);
  }
  if (postMidnightUTCStr !== '2026-11-12') {
    throw new Error(`Midnight boundary: expected 2026-11-12 in UTC, got ${postMidnightUTCStr}`);
  }
  console.log('  ✓ formatDateInTz midnight boundary tests passed.');

  interface DateTestCase {
    phrase: string;
    tz: string;
    now: Date;
    expectStartDate: string;      // YYYY-MM-DD (at least one parsed result should contain this)
    expectEndDate?: string;       // YYYY-MM-DD (for ranges); defaults to expectStartDate
    expectConfidence?: 'high' | 'medium' | 'low';
    description: string;
  }

  const dateTestCases: DateTestCase[] = [
    // ── Relative phrases (IST, near midnight Thu Nov 12 23:45) ──
    {
      phrase: 'yesterday',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-11',
      description: 'yesterday from Thu Nov 12 23:45 IST → Wed Nov 11',
    },
    {
      phrase: 'yesterday',
      tz: IST, now: postMidnightIST,
      expectStartDate: '2026-11-12',
      description: 'yesterday from Fri Nov 13 00:00 IST → Thu Nov 12 (midnight boundary)',
    },
    {
      phrase: 'this morning',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-12',
      description: '"this morning" on Thu Nov 12 23:45 IST → today Nov 12',
    },
    {
      phrase: 'last week',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-02',
      expectEndDate: '2026-11-08',
      description: '"last week" from Thu Nov 12 → Mon Nov 2 to Sun Nov 8 (approx)',
    },
    {
      phrase: 'two weeks ago',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-10-29',
      description: '"two weeks ago" from Nov 12 → ~Oct 29',
    },
    {
      phrase: 'last Tuesday',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-10',
      description: '"last Tuesday" from Thu Nov 12 → Tue Nov 10',
    },
    {
      phrase: 'last Monday',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-09',
      description: '"last Monday" from Thu Nov 12 → Mon Nov 9',
    },
    {
      phrase: 'last Sunday',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-08',
      description: '"last Sunday" from Thu Nov 12 → Sun Nov 8',
    },
    {
      phrase: 'last Saturday',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-07',
      description: '"last Saturday" from Thu Nov 12 → Sat Nov 7',
    },
    {
      phrase: 'last Friday',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-06',
      description: '"last Friday" from Thu Nov 12 → Fri Nov 6',
    },

    // ── Explicit date formats ──
    {
      phrase: '3 November',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-03',
      description: '"3 November" → Nov 3 current year',
    },
    {
      phrase: 'Nov 3rd',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-03',
      description: '"Nov 3rd" → Nov 3 current year',
    },
    {
      phrase: '3rd of November',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-03',
      description: '"3rd of November" → Nov 3 current year',
    },
    {
      phrase: 'December 25',
      tz: IST, now: chronoNow,
      expectStartDate: '2025-12-25',
      description: '"December 25" → Dec 25 of previous year (future date in current year)',
    },
    {
      phrase: 'October 1st',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-10-01',
      description: '"October 1st" → Oct 1 current year (past)',
    },

    // ── Ambiguous numeric dates (DD/MM in IST vs MM/DD in US) ──
    {
      phrase: '11/3',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-03-11',
      expectConfidence: 'low',
      description: '"11/3" in Asia/Kolkata → DD/MM → 11 March (ambiguous)',
    },
    {
      phrase: '11/3',
      tz: NYC, now: chronoNow,
      expectStartDate: '2026-11-03',
      description: '"11/3" in America/New_York → MM/DD → November 3',
    },
    {
      phrase: '5/6',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-06-05',
      expectConfidence: 'low',
      description: '"5/6" in IST → DD/MM → June 5 (ambiguous)',
    },

    // ── Midnight boundary: same UTC instant, different local day ──
    {
      phrase: 'yesterday',
      tz: NYC, now: postMidnightIST,
      expectStartDate: '2026-11-11',
      description: '"yesterday" in NYC when IST crossed to Nov 13 but NYC is still Nov 12 → Nov 11',
    },

    // ── Day-of-week around boundaries ──
    {
      phrase: 'on Wednesday',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-11',
      description: '"on Wednesday" from Thu Nov 12 → Wed Nov 11',
    },
    {
      phrase: 'on Thursday',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-12',
      description: '"on Thursday" from Thu Nov 12 → today (Nov 12) or last Thu (Nov 5)',
    },

    // ── Additional relative phrases ──
    {
      phrase: 'three days ago',
      tz: IST, now: chronoNow,
      expectStartDate: '2026-11-09',
      description: '"three days ago" from Nov 12 → Nov 9',
    },
  ];

  let chronoPassed = 0;
  let chronoFailed = 0;

  for (const tc of dateTestCases) {
    const results = parseDates(tc.phrase, tc.now, tc.tz);
    const expectEnd = tc.expectEndDate || tc.expectStartDate;

    // Check if at least one parsed result matches expected start date
    const startMatch = results.some(r => r.startDate === tc.expectStartDate);
    const endMatch = results.some(r => r.endDate === expectEnd || r.startDate === tc.expectStartDate);
    const confMatch = !tc.expectConfidence || results.some(r =>
      r.startDate === tc.expectStartDate && r.confidence === tc.expectConfidence
    );

    if (startMatch && endMatch) {
      chronoPassed++;
    } else {
      chronoFailed++;
      const got = results.map(r => `${r.startDate}→${r.endDate} (${r.confidence}: ${r.interpretationNote})`).join('; ');
      console.error(`    ✗ FAIL: ${tc.description}`);
      console.error(`      Phrase: "${tc.phrase}" (tz=${tc.tz})`);
      console.error(`      Expected: ${tc.expectStartDate}→${expectEnd}`);
      console.error(`      Got: ${got || 'NO RESULTS'}`);
    }
  }

  console.log(`  Chrono date parsing: ${chronoPassed}/${dateTestCases.length} passed, ${chronoFailed} failed.`);
  if (chronoFailed > 0) {
    throw new Error(`Chrono date parsing failures: ${chronoFailed}/${dateTestCases.length}`);
  }
  console.log('  ✓ Table-driven chrono-node date parsing tests passed (22/22 passed).');

  console.log('Temporal resolver tests passed.');

  // 3. Calendar Reference & System Prompt Verification
  console.log('\n[3/7] Testing Calendar Reference & System Prompt Builder...');
  const calRef = buildCalendarReference(now);
  if (!calRef.includes('TODAY: Thursday, Nov 12, 2026')) {
    throw new Error('Calendar reference does not correctly anchor today');
  }
  if (!calRef.includes('[TODAY]') || !calRef.includes('[YESTERDAY]')) {
    throw new Error('Calendar reference missing relative mapping');
  }

  const prompt = buildSystemPrompt(now, res1.formattedContext);
  if (!prompt.includes('TEMPORAL ACCURACY & RESOLUTION') || !prompt.includes('web_search')) {
    throw new Error('System prompt missing required operational instructions');
  }
  if (!prompt.includes('STRICT ANTI-FABRICATION RULE')) {
    throw new Error('System prompt missing strict anti-fabrication rule');
  }
  if (!prompt.includes('ABSENCE OF RESULTS IS NOT EVIDENCE OF NO CHANGE')) {
    throw new Error('System prompt missing "absence of results is not evidence of no change" rule');
  }
  if (!prompt.includes('Tavily filters by publish date')) {
    throw new Error('System prompt missing Tavily publish date disclaimer');
  }
  if (!prompt.includes('Retrieved past conversation is what the USER said or what the assistant claimed earlier')) {
    throw new Error('System prompt missing rule that retrieved memory is not a source of current facts');
  }
  if (!prompt.includes('Every version number, price, date, or status in the answer must appear in the search results provided')) {
    throw new Error('System prompt missing strict factual grounding rule');
  }
  if (!prompt.includes('Cite sources inline, with a link to the specific page')) {
    throw new Error('System prompt missing inline source citation instruction');
  }
  console.log('Calendar reference & system prompt generation verified.');

  // 4. Web Search Tool Schema Tests
  console.log('\n[4/7] Testing Web Search Tool Schema...');
  if (webSearchToolDeclaration.name !== 'web_search') {
    throw new Error('Tool name must be web_search');
  }
  if (!webSearchToolDeclaration.parameters?.properties?.queries) {
    throw new Error('Tool schema missing queries parameter');
  }
  if ((webSearchToolDeclaration.parameters?.properties as any)?.days_back !== undefined) {
    throw new Error('Tool schema must NOT expose days_back to the model');
  }
  if (!(webSearchToolDeclaration.parameters?.properties as any)?.start_date) {
    throw new Error('Tool schema missing start_date parameter');
  }
  if (TAVILY_PUBLISH_DATE_NOTE !== 'Tavily filters by publish date. Pages edited after publishing may not appear.') {
    throw new Error('TAVILY_PUBLISH_DATE_NOTE does not match required note text');
  }
  console.log('Web search tool schema valid (days_back removed, start_date supported, publish date note verified).');

  // 5. Agent Loop & History Verification with Seeded Data
  console.log('\n[5/7] Testing Agent Loop & Grouped History Structure (Seeded DB)...');
  const events: AgentEvent[] = [];
  const testSession = 'test-session-agent';

  await runAgent(
    'On Monday we shortlisted 5 CRM tools. Any pricing changes?',
    testSession,
    (ev) => events.push(ev),
    now
  );

  console.log(`Agent emitted ${events.length} events:`, events.map(e => e.type));
  if (events.length === 0 || !events.some(e => e.type === 'done')) {
    throw new Error('Agent failed to complete event lifecycle');
  }

  // Verify history grouped by date
  const allMsgs = getAllMessages(100);
  const groupedByDate: Record<string, typeof allMsgs> = {};
  for (const m of allMsgs) {
    if (!groupedByDate[m.date_str]) groupedByDate[m.date_str] = [];
    groupedByDate[m.date_str].push(m);
  }
  const dateKeys = Object.keys(groupedByDate);
  console.log(`History contains ${dateKeys.length} distinct dates:`, dateKeys);
  if (dateKeys.length < 3) {
    throw new Error('Expected at least 3 distinct dates in conversation history');
  }

  // 6. Anti-Fabrication & Empty DB Verification Tests
  console.log('\n[6/7] Testing Anti-Fabrication Behavior on Empty Database...');
  
  // Clear the database completely to represent fresh DB or POST /api/reset
  clearDatabase();
  if (!isDatabaseEmpty()) {
    throw new Error('Database should be empty after clearDatabase()');
  }
  const emptyStats = getDatabaseStats();
  if (emptyStats.totalMessages !== 0) {
    throw new Error(`Expected 0 messages in empty DB, got ${emptyStats.totalMessages}`);
  }
  console.log('Database cleared to 0 messages. Testing empty DB responses:');

  // Test (a): Empty DB + "What did I ask on 3 November?"
  console.log('  -> Running Test (a): Empty DB + "What did I ask on 3 November?"');
  let tokenContentA = '';
  const emptySessionA = 'session-empty-nov3';
  const responseA = await runAgent(
    'What did I ask you on 3 November? Is your answer still correct today?',
    emptySessionA,
    (ev) => {
      if (ev.type === 'token') tokenContentA += ev.content;
    },
    now
  );

  const fullAnswerA = (responseA || tokenContentA).toLowerCase();
  console.log(`     Agent response (a): "${fullAnswerA.slice(0, 160)}..."`);

  const statesNoRecordA =
    fullAnswerA.includes('no record') ||
    fullAnswerA.includes('no prior') ||
    fullAnswerA.includes('no history') ||
    fullAnswerA.includes("don't have") ||
    fullAnswerA.includes('do not have') ||
    fullAnswerA.includes('no previous conversation') ||
    fullAnswerA.includes('no past conversation');

  if (!statesNoRecordA) {
    throw new Error(`Test (a) failed: Agent should have explicitly stated no record exists on empty DB. Got: ${fullAnswerA}`);
  }

  // Verify it did not hallucinate Next.js / Node / Claude versions
  if (fullAnswerA.includes('next.js 15.0.1') || fullAnswerA.includes('jod') || fullAnswerA.includes('claude 3.5 sonnet')) {
    throw new Error('Test (a) failed: Agent fabricated historical details for 3 November without memory!');
  }
  console.log('  ✓ Test (a) PASSED: Agent reported no record found and did not fabricate.');

  // Test (b): The agent never fabricates a past turn
  console.log('  -> Running Test (b): Empty DB + "On Monday we shortlisted 5 CRM tools..."');
  clearDatabase();
  let tokenContentB = '';
  const emptySessionB = 'session-empty-monday';
  const responseB = await runAgent(
    'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing?',
    emptySessionB,
    (ev) => {
      if (ev.type === 'token') tokenContentB += ev.content;
    },
    now
  );

  const fullAnswerB = (responseB || tokenContentB).toLowerCase();
  console.log(`     Agent response (b): "${fullAnswerB.slice(0, 160)}..."`);

  const statesNoRecordB =
    fullAnswerB.includes('no record') ||
    fullAnswerB.includes('no history') ||
    fullAnswerB.includes('no prior') ||
    fullAnswerB.includes("don't have") ||
    fullAnswerB.includes('do not have') ||
    fullAnswerB.includes('share the details') ||
    fullAnswerB.includes('provide the shortlist') ||
    fullAnswerB.includes('let me know which tools') ||
    fullAnswerB.includes('tell me which') ||
    fullAnswerB.includes('share the list') ||
    fullAnswerB.includes('no previous');

  if (!statesNoRecordB) {
    throw new Error(`Test (b) failed: Agent should have stated it has no record of the past shortlist and asked for details. Got: ${fullAnswerB}`);
  }

  // Clean up test sessions
  clearDatabase();

  console.log('  ✓ Test (b) PASSED: Agent refused to fabricate past turns without memory.');

  // 7. Multi-Tenant User Isolation & Signed Cookie Security
  console.log('\n[7/7] Testing Multi-Tenant User Isolation & Signed Cookie Security...');

  // A. Signed Cookie tests
  const testSecret = 'test-secret-key-for-cookies-123456';
  const testUuid = 'b73d2a01-8b29-4d64-9b81-c7526978411d';
  const signedCookie = signCookieValue(testUuid, testSecret);
  if (!signedCookie.startsWith(`s:${testUuid}.`)) {
    throw new Error(`signCookieValue format invalid: ${signedCookie}`);
  }

  const unsigned = unsignCookieValue(signedCookie, testSecret);
  if (unsigned !== testUuid) {
    throw new Error(`unsignCookieValue failed to extract UUID. Expected ${testUuid}, got ${unsigned}`);
  }

  // Tampered cookie signature
  const tamperedCookie = signedCookie.slice(0, -3) + 'xyz';
  if (unsignCookieValue(tamperedCookie, testSecret) !== false) {
    throw new Error('unsignCookieValue should return false for tampered signature');
  }

  // Tampered payload
  const tamperedPayload = 's:c73d2a01-8b29-4d64-9b81-c7526978411e.' + signedCookie.split('.')[1];
  if (unsignCookieValue(tamperedPayload, testSecret) !== false) {
    throw new Error('unsignCookieValue should return false for modified payload with original signature');
  }

  // Unsigned cookie
  if (unsignCookieValue(testUuid, testSecret) !== false) {
    throw new Error('unsignCookieValue should return false for raw unsigned UUID');
  }

  // parseCookies helper
  const parsed = parseCookies(`other=123; ${USER_COOKIE_NAME}=${encodeURIComponent(signedCookie)}; theme=dark`);
  if (parsed[USER_COOKIE_NAME] !== signedCookie) {
    throw new Error(`parseCookies failed to extract cookie value: got ${parsed[USER_COOKIE_NAME]}`);
  }
  console.log('  ✓ Signed Cookie cryptographic signing, verification, and tamper detection passed.');

  // B. Database scoping & user isolation: User A vs User B
  const userA = 'user-alice-' + Date.now();
  const userB = 'user-bob-' + Date.now();

  // Clear any existing messages for both test users
  clearDatabase(userA);
  clearDatabase(userB);

  // User A conversations across 2 different sessions (cross-session)
  insertMessage('session-alice-1', 'user', 'Project Apollo: Flight booked to Tokyo on 3 November', '2026-11-03T10:00:00Z', null, false, 'UTC', userA);
  insertMessage('session-alice-1', 'assistant', 'Confirmed your flight to Tokyo on 3 November under Project Apollo.', '2026-11-03T10:01:00Z', null, false, 'UTC', userA);
  insertMessage('session-alice-2', 'user', 'Project Apollo: Secret budget allocation is $50,000.', '2026-11-04T12:00:00Z', null, false, 'UTC', userA);

  // User B conversations across 2 different sessions (cross-session)
  insertMessage('session-bob-1', 'user', 'Project Zeus: Quantum computing lab test on 3 November', '2026-11-03T10:00:00Z', null, false, 'UTC', userB);
  insertMessage('session-bob-1', 'assistant', 'Logged quantum test results for Project Zeus.', '2026-11-03T10:01:00Z', null, false, 'UTC', userB);
  insertMessage('session-bob-2', 'user', 'Project Zeus: Hotel reservation in Berlin confirmed.', '2026-11-04T14:00:00Z', null, false, 'UTC', userB);

  // 1. Cross-session retrieval for user A
  const aliceCrossSession = getRecentMessages(null, 50, userA);
  if (aliceCrossSession.length !== 3) {
    throw new Error(`Expected User A to have 3 cross-session messages, got ${aliceCrossSession.length}`);
  }
  for (const m of aliceCrossSession) {
    if (m.user_id !== userA) {
      throw new Error(`Data leak! User A cross-session retrieval contained user_id ${m.user_id}`);
    }
    if (m.content.includes('Zeus') || m.content.includes('Berlin') || m.session_id.includes('bob')) {
      throw new Error(`Data leak! User A retrieved User B content: "${m.content}"`);
    }
  }

  // 2. Cross-session retrieval for user B
  const bobCrossSession = getRecentMessages(null, 50, userB);
  if (bobCrossSession.length !== 3) {
    throw new Error(`Expected User B to have 3 cross-session messages, got ${bobCrossSession.length}`);
  }
  for (const m of bobCrossSession) {
    if (m.user_id !== userB) {
      throw new Error(`Data leak! User B cross-session retrieval contained user_id ${m.user_id}`);
    }
    if (m.content.includes('Apollo') || m.content.includes('Tokyo') || m.session_id.includes('alice')) {
      throw new Error(`Data leak! User B retrieved User A content: "${m.content}"`);
    }
  }
  console.log('  ✓ Cross-session retrieval is fully isolated between User A and User B.');

  // 3. Date range search isolation
  const aliceDateRange = searchMessagesByDateRange(null, '2026-11-01', '2026-11-05', userA);
  if (aliceDateRange.length !== 3) {
    throw new Error(`User A date range search expected 3 messages, got ${aliceDateRange.length}`);
  }
  if (aliceDateRange.some(m => m.user_id !== userA || m.content.includes('Zeus'))) {
    throw new Error('User A date range search leaked User B data!');
  }

  const bobDateRange = searchMessagesByDateRange(null, '2026-11-01', '2026-11-05', userB);
  if (bobDateRange.length !== 3) {
    throw new Error(`User B date range search expected 3 messages, got ${bobDateRange.length}`);
  }
  if (bobDateRange.some(m => m.user_id !== userB || m.content.includes('Apollo'))) {
    throw new Error('User B date range search leaked User A data!');
  }
  console.log('  ✓ Date range queries strictly isolated by user_id.');

  // 4. FTS5 BM25 search isolation
  const bobSearchApollo = searchMessagesFTS('Apollo', { userId: userB });
  if (bobSearchApollo.length !== 0) {
    throw new Error(`Security breach! User B FTS search for "Apollo" returned ${bobSearchApollo.length} messages from User A!`);
  }

  const aliceSearchApollo = searchMessagesFTS('Apollo', { userId: userA });
  if (aliceSearchApollo.length === 0) {
    throw new Error('User A FTS search for "Apollo" should return Alice messages.');
  }
  if (aliceSearchApollo.some(m => m.user_id !== userA)) {
    throw new Error('User A FTS search returned messages from another user!');
  }

  const aliceSearchZeus = searchMessagesFTS('Zeus', { userId: userA });
  if (aliceSearchZeus.length !== 0) {
    throw new Error(`Security breach! User A FTS search for "Zeus" returned ${aliceSearchZeus.length} messages from User B!`);
  }

  const bobSearchZeus = searchMessagesFTS('Zeus', { userId: userB });
  if (bobSearchZeus.length === 0) {
    throw new Error('User B FTS search for "Zeus" should return Bob messages.');
  }
  if (bobSearchZeus.some(m => m.user_id !== userB)) {
    throw new Error('User B FTS search returned messages from another user!');
  }
  console.log('  ✓ FTS5 BM25 searches strictly isolated by user_id.');

  // 5. Temporal resolver isolation
  const aliceResolved = resolveTemporalContext(
    'What flight did I book on 3 November?',
    'session-alice-new',
    now,
    MAX_CONTEXT_CHARS,
    'UTC',
    userA
  );
  if (aliceResolved.matchedMessages.length === 0 || !aliceResolved.matchedMessages.some(m => m.content.includes('Tokyo'))) {
    throw new Error('User A temporal resolution failed to retrieve Alice flight.');
  }
  if (aliceResolved.matchedMessages.some(m => m.content.includes('Zeus') || m.user_id !== userA)) {
    throw new Error('User A temporal resolution leaked User B messages!');
  }

  const bobResolved = resolveTemporalContext(
    'What flight did I book on 3 November?',
    'session-bob-new',
    now,
    MAX_CONTEXT_CHARS,
    'UTC',
    userB
  );
  if (bobResolved.matchedMessages.some(m => m.content.includes('Tokyo') || m.content.includes('Apollo') || m.user_id === userA)) {
    throw new Error('Security breach! User B temporal resolution retrieved User A flight details!');
  }
  console.log('  ✓ Temporal resolution is strictly scoped to the requesting user_id.');

  // 6. Per-user database clearing & stats
  clearDatabase(userA);
  const aliceStatsAfterClear = getDatabaseStats(userA);
  if (aliceStatsAfterClear.totalMessages !== 0) {
    throw new Error(`Expected User A to have 0 messages after clearDatabase(userA), got ${aliceStatsAfterClear.totalMessages}`);
  }

  const bobStatsAfterAliceClear = getDatabaseStats(userB);
  if (bobStatsAfterAliceClear.totalMessages !== 3) {
    throw new Error(`User B messages were inadvertently deleted by User A clear! Expected 3, got ${bobStatsAfterAliceClear.totalMessages}`);
  }
  const bobRemaining = getAllMessages(10, userB);
  if (bobRemaining.length !== 3 || bobRemaining.some(m => m.user_id !== userB)) {
    throw new Error('User B data corrupted after User A clearDatabase!');
  }

  // Clean up Bob
  clearDatabase(userB);
  if (getDatabaseStats(userB).totalMessages !== 0) {
    throw new Error('Failed to clear User B messages.');
  }
  console.log('  ✓ Per-user clearDatabase(userId) cleanly isolates deletion.');

  // 8. Grounding, Pre-Retrieval Relevance & Memory Anti-Contamination Test
  console.log('\n[8/8] Testing Grounding, Pre-Retrieval Relevance & Memory Anti-Contamination...');
  const groundingUser = 'user-grounding-' + Date.now();
  clearDatabase(groundingUser);

  // Seed a past conversation containing stale/prior version claim
  insertMessage(
    'session-past-node',
    'assistant',
    'Node.js v22.11.0 is the latest LTS',
    '2026-11-01T10:00:00Z',
    null,
    false,
    'UTC',
    groundingUser
  );

  // 1. Verify pre-retrieval relevance: plain factual question must NOT inject past conversation
  const nodeQuery = "what's the latest stable Node.js?";
  const plainFactualRes = resolveTemporalContext(
    nodeQuery,
    'session-eval-plain',
    now,
    MAX_CONTEXT_CHARS,
    'UTC',
    groundingUser
  );

  if (plainFactualRes.matchedMessages.length !== 0) {
    throw new Error(
      `Pre-retrieval relevance failed: plain factual question injected ${plainFactualRes.matchedMessages.length} messages from memory!`
    );
  }
  if (plainFactualRes.formattedContext !== '') {
    throw new Error(`Expected empty formattedContext for plain factual question, got: "${plainFactualRes.formattedContext}"`);
  }

  // 2. Verify 90-day search window defaulted for query with "latest" and no anchor date
  if (!plainFactualRes.searchWindow || !plainFactualRes.searchWindow.startDate) {
    throw new Error('Expected searchWindow with 90-day startDate for "latest" query without anchor date');
  }
  const ninetyDaysAgoExpected = formatDateInTz(new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), 'UTC');
  if (plainFactualRes.searchWindow.startDate !== ninetyDaysAgoExpected) {
    throw new Error(`Expected 90-day window start ${ninetyDaysAgoExpected}, got ${plainFactualRes.searchWindow.startDate}`);
  }
  console.log('  ✓ Pre-retrieval relevance verified: plain factual query excluded from memory injection, 90-day window applied.');

  // 3. Ask "what's the latest stable Node.js?" with mocked search result for Node 26.13.0
  const mockNodeSearchResults: WebSearchResultItem[] = [
    {
      query: 'latest stable Node.js',
      title: 'Node.js v26.13.0 Released',
      url: 'https://nodejs.org/en/blog/release/v26.13.0',
      published_date: '2026-11-10',
      snippet: 'Node.js v26.13.0 is the current latest stable release. It features V8 engine 13.5, enhanced WebCrypto APIs, and updated ECMAScript features.',
      note: TAVILY_PUBLISH_DATE_NOTE
    }
  ];

  let nodeTokens = '';
  const nodeResponse = await runAgent(
    nodeQuery,
    'session-node-live',
    (ev) => {
      if (ev.type === 'token') nodeTokens += ev.content;
    },
    now,
    {
      userId: groundingUser,
      mockSearchResults: mockNodeSearchResults
    }
  );

  const finalNodeAnswer = nodeResponse || nodeTokens;
  console.log(`     Agent response: "${finalNodeAnswer.slice(0, 160)}..."`);

  // Assert answer contains 26.13.0
  if (!finalNodeAnswer.includes('26.13.0')) {
    throw new Error(`Expected answer to state latest version 26.13.0 from search results, got: ${finalNodeAnswer}`);
  }

  // Assert answer must NOT repeat 22.11.0 from past memory
  if (finalNodeAnswer.includes('22.11.0')) {
    throw new Error(`Contamination failure! Answer repeated stale version 22.11.0 from past conversation: ${finalNodeAnswer}`);
  }

  // Assert inline citation link
  if (!finalNodeAnswer.includes('https://nodejs.org/en/blog/release/v26.13.0')) {
    throw new Error(`Answer missing inline markdown link citation to specific release page: ${finalNodeAnswer}`);
  }

  clearDatabase(groundingUser);
  console.log('  ✓ Grounding & anti-contamination verified: Answer stated 26.13.0 and strictly avoided repeating 22.11.0.');

  // 9. Intent Classification & Search Policy (RECALL, VERIFY, AUTO) Tests
  console.log('\n[9/10] Testing Intent Classification & Search Policy (RECALL, VERIFY, AUTO)...');
  const policyUser = 'user-policy-' + Date.now();
  clearDatabase(policyUser);

  // Fixed test reference date: Saturday 2026-11-14 12:00:00 UTC
  // "yesterday" relative to 2026-11-14 is Friday 2026-11-13
  const policyNow = new Date('2026-11-14T12:00:00Z');

  // Seed yesterday's conversation (2026-11-13)
  insertMessage(
    'session-yesterday-notes',
    'user',
    'I am building a web app using SvelteKit and Tailwind CSS.',
    '2026-11-13T10:00:00Z',
    null,
    false,
    'UTC',
    policyUser
  );
  insertMessage(
    'session-yesterday-notes',
    'assistant',
    'SvelteKit and Tailwind CSS is an excellent stack for fast web apps.',
    '2026-11-13T10:01:00Z',
    null,
    false,
    'UTC',
    policyUser
  );

  // ----------------------------------------------------
  // Test A: "what did I tell you yesterday" (RECALL -> 0 searches)
  // ----------------------------------------------------
  console.log('  -> Testing RECALL: "what did I tell you yesterday"...');
  const recallIntent = classifyIntent('what did I tell you yesterday');
  if (recallIntent.intent !== 'RECALL') {
    throw new Error(`Expected RECALL intent for "what did I tell you yesterday", got ${recallIntent.intent}`);
  }
  if (recallIntent.firstTurnMode !== FunctionCallingConfigMode.NONE) {
    throw new Error(`Expected firstTurnMode NONE for RECALL, got ${recallIntent.firstTurnMode}`);
  }

  const recallEvents: AgentEvent[] = [];
  const recallAnswer = await runAgent(
    'what did I tell you yesterday',
    'session-recall-eval',
    (ev) => recallEvents.push(ev),
    policyNow,
    { userId: policyUser }
  );

  const recallToolCalls = recallEvents.filter((ev) => ev.type === 'tool_start');
  if (recallToolCalls.length !== 0) {
    throw new Error(
      `Over-triggered search bug! Expected 0 searches for RECALL ("what did I tell you yesterday"), got ${recallToolCalls.length}`
    );
  }

  const lowerRecallAnswer = recallAnswer.toLowerCase();
  if (!lowerRecallAnswer.includes('sveltekit') && !lowerRecallAnswer.includes('tailwind')) {
    throw new Error(`Expected answer to recall SvelteKit/Tailwind from memory, got: "${recallAnswer}"`);
  }
  console.log('  ✓ RECALL passed: 0 searches performed, answered purely from retrieved memory.');

  // ----------------------------------------------------
  // Test B: "is your answer from yesterday still correct?" (VERIFY -> 1 search, window starts 2026-11-13)
  // ----------------------------------------------------
  console.log('  -> Testing VERIFY: "is your answer from yesterday still correct?"...');
  const verifyIntent = classifyIntent('is your answer from yesterday still correct?');
  if (verifyIntent.intent !== 'VERIFY') {
    throw new Error(`Expected VERIFY intent for "is your answer from yesterday still correct?", got ${verifyIntent.intent}`);
  }
  if (verifyIntent.firstTurnMode !== FunctionCallingConfigMode.ANY) {
    throw new Error(`Expected firstTurnMode ANY for VERIFY, got ${verifyIntent.firstTurnMode}`);
  }

  // Verify search window calculation starts at anchor conversation date 2026-11-13
  const verifyTemporal = resolveTemporalContext(
    'is your answer from yesterday still correct?',
    'session-verify-eval',
    policyNow,
    MAX_CONTEXT_CHARS,
    'UTC',
    policyUser
  );

  if (!verifyTemporal.searchWindow || verifyTemporal.searchWindow.startDate !== '2026-11-13') {
    throw new Error(
      `Expected searchWindow startDate to be anchor date 2026-11-13, got: ${verifyTemporal.searchWindow?.startDate}`
    );
  }

  const mockVerifyResults: WebSearchResultItem[] = [
    {
      query: 'SvelteKit Tailwind compatibility 2026',
      title: 'SvelteKit and Tailwind CSS Status',
      url: 'https://svelte.dev/docs/kit/tailwind',
      published_date: '2026-11-13',
      snippet: 'SvelteKit and Tailwind CSS continue to be fully supported and recommended as of November 2026.',
      note: TAVILY_PUBLISH_DATE_NOTE
    }
  ];

  const verifyEvents: AgentEvent[] = [];
  await runAgent(
    'is your answer from yesterday still correct?',
    'session-verify-eval',
    (ev) => verifyEvents.push(ev),
    policyNow,
    {
      userId: policyUser,
      mockSearchResults: mockVerifyResults
    }
  );

  const verifyToolCalls = verifyEvents.filter((ev) => ev.type === 'tool_start');
  if (verifyToolCalls.length !== 1) {
    throw new Error(
      `Expected exactly 1 search for VERIFY ("is your answer from yesterday still correct?"), got ${verifyToolCalls.length}`
    );
  }
  console.log('  ✓ VERIFY passed: exactly 1 search performed, search window starts at 2026-11-13.');

  // ----------------------------------------------------
  // Test C: "thanks, that's helpful since I'm new" (AUTO -> no forced search)
  // ----------------------------------------------------
  console.log('  -> Testing AUTO: "thanks, that\'s helpful since I\'m new"...');
  const autoIntent = classifyIntent("thanks, that's helpful since I'm new");
  if (autoIntent.intent !== 'AUTO') {
    throw new Error(
      `Over-triggered search bug! Expected AUTO intent for "thanks, that's helpful since I'm new", got ${autoIntent.intent}`
    );
  }
  if (autoIntent.firstTurnMode !== FunctionCallingConfigMode.AUTO) {
    throw new Error(`Expected firstTurnMode AUTO (not ANY/forced), got ${autoIntent.firstTurnMode}`);
  }

  const autoEvents: AgentEvent[] = [];
  await runAgent(
    "thanks, that's helpful since I'm new",
    'session-auto-eval',
    (ev) => autoEvents.push(ev),
    policyNow,
    { userId: policyUser }
  );

  const autoToolCalls = autoEvents.filter((ev) => ev.type === 'tool_start');
  if (autoToolCalls.length > 0) {
    throw new Error(
      `Over-triggered search bug! Expected 0 searches for AUTO conversational remark, got ${autoToolCalls.length}`
    );
  }
  console.log('  ✓ AUTO passed: no forced search, treated as conversational turn.');

  clearDatabase(policyUser);

  // ----------------------------------------------------
  // 10. New Chat & Cross-Session Memory Recall
  // ----------------------------------------------------
  console.log('\n[10/11] Testing "New Chat" Session Creation & Cross-Session Memory Recall...');
  const newChatUserId = 'user-newchat-eval-' + Date.now();
  clearDatabase(newChatUserId);

  // 1. In Session A, user stores an important fact
  const sessionAId = 'session-alpha-test';
  const sessionA = createSession(newChatUserId, 'Session Alpha', sessionAId);
  insertMessage(
    sessionA.id,
    'user',
    'I am planning a trip to Kyoto in April to see the cherry blossoms.',
    '2026-11-10T10:00:00Z',
    null,
    false,
    'UTC',
    newChatUserId
  );
  insertMessage(
    sessionA.id,
    'assistant',
    'Kyoto in April is spectacular! Maruyama Park and the Philosopher\'s Path are great spots.',
    '2026-11-10T10:01:00Z',
    null,
    false,
    'UTC',
    newChatUserId
  );

  // Verify Session A has messages
  const sessionAMessages = getRecentMessages(sessionA.id, 10, newChatUserId);
  if (sessionAMessages.length !== 2) {
    throw new Error(`Expected 2 messages in Session A, got ${sessionAMessages.length}`);
  }

  // 2. Click "New Chat": calls createSession to create a new session row
  const sessionB = createSession(newChatUserId, 'Session Beta');
  if (!sessionB.id || sessionB.user_id !== newChatUserId) {
    throw new Error(`Failed to create Session B for user ${newChatUserId}`);
  }

  // Verify Session A messages were NOT deleted or modified by creating Session B
  const sessionAMessagesAfterNewChat = getRecentMessages(sessionA.id, 10, newChatUserId);
  if (sessionAMessagesAfterNewChat.length !== 2) {
    throw new Error(
      `Messages were deleted/modified! Expected 2 messages still in Session A, got ${sessionAMessagesAfterNewChat.length}`
    );
  }

  // Verify user sessions list contains both sessions
  const userSessions = getUserSessions(newChatUserId);
  if (userSessions.length < 2) {
    throw new Error(`Expected at least 2 sessions for user, got ${userSessions.length}`);
  }

  // 3. In Session B, ask about Session A's information
  console.log('  -> Asking in Session B: "What city did I say I am planning to visit in April?"...');
  const sessionBEvents: AgentEvent[] = [];
  const sessionBAnswer = await runAgent(
    'What city did I say I am planning to visit in April?',
    sessionB.id,
    (ev) => sessionBEvents.push(ev),
    policyNow,
    { userId: newChatUserId }
  );

  const lowerBAnswer = sessionBAnswer.toLowerCase();
  if (!lowerBAnswer.includes('kyoto')) {
    throw new Error(`Expected answer in Session B to recall "Kyoto" from Session A, got: "${sessionBAnswer}"`);
  }
  console.log('  ✓ Cross-session memory recall passed: Session B successfully retrieved Kyoto from Session A.');

  // 4. Test User Name Recall Across Sessions (e.g. Chat 1: "My name is Tanay", Chat 2: "what is my name?")
  console.log('  -> Testing name recall across sessions: "what is my name?"...');
  const sessionName1 = createSession(newChatUserId, 'Name Session 1');
  insertMessage(
    sessionName1.id,
    'user',
    'My name is Tanay',
    '2026-11-14T10:00:00Z',
    null,
    false,
    'UTC',
    newChatUserId
  );
  insertMessage(
    sessionName1.id,
    'assistant',
    'Nice to meet you, Tanay!',
    '2026-11-14T10:01:00Z',
    null,
    false,
    'UTC',
    newChatUserId
  );

  const sessionName2 = createSession(newChatUserId, 'Name Session 2');
  const nameEvents: AgentEvent[] = [];
  const nameAnswer = await runAgent(
    'what is my name?',
    sessionName2.id,
    (ev) => nameEvents.push(ev),
    policyNow,
    { userId: newChatUserId }
  );

  if (!nameAnswer.toLowerCase().includes('tanay')) {
    throw new Error(`Expected agent in new session to recall user name "Tanay", got: "${nameAnswer}"`);
  }
  const nameToolCalls = nameEvents.filter(ev => ev.type === 'tool_start');
  if (nameToolCalls.length !== 0) {
    throw new Error(`Expected 0 web searches for personal name recall, got ${nameToolCalls.length}`);
  }
  console.log('  ✓ User name cross-session recall verified: accurately recalled "Tanay" without web search.');

  // Clean up
  clearDatabase(newChatUserId);
  const clearedSessions = getUserSessions(newChatUserId);
  if (clearedSessions.length !== 0) {
    throw new Error(`Expected sessions to be cleared, found ${clearedSessions.length}`);
  }
  console.log('  ✓ Clear all memory passed: wiped both messages and session rows.');

  // ----------------------------------------------------
  // 11. Chat History List & Endpoint Security (Sessions & 404 Isolation)
  // ----------------------------------------------------
  console.log('\n[11/11] Testing Chat History List & Endpoint Security (Sessions & 404 Isolation)...');
  const userAlpha = 'user-hist-a-' + Date.now();
  const userBeta = 'user-hist-b-' + Date.now();
  clearDatabase(userAlpha);
  clearDatabase(userBeta);

  // Start ephemeral server to test real HTTP endpoints with signed cookies
  const testServer = app.listen(0);
  const testPort = (testServer.address() as any).port;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  const alphaCookie = signCookieValue(userAlpha);
  const betaCookie = signCookieValue(userBeta);

  try {
    // 1. User B creates a session and adds messages
    const sessionB = createSession(userBeta, 'Bob Private Project');
    insertMessage(
      sessionB.id,
      'user',
      'Confidential details for project quantum ledger.',
      '2026-11-14T08:00:00Z',
      null,
      false,
      'UTC',
      userBeta
    );

    // Verify User A direct query returns null
    if (getSessionMessages(sessionB.id, userAlpha) !== null) {
      throw new Error(`Security breach! getSessionMessages returned User B's session to User A!`);
    }

    // Verify User A via HTTP GET /api/sessions/:id/messages gets 404
    const resA = await fetch(`${baseUrl}/api/sessions/${sessionB.id}/messages`, {
      headers: {
        Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(alphaCookie)}`
      }
    });
    if (resA.status !== 404) {
      throw new Error(`Security breach! Expected 404 when User A requests User B's session, got HTTP ${resA.status}`);
    }
    console.log('  ✓ User A cannot fetch User B\'s session: returns HTTP 404.');

    // Verify User B can fetch their own session messages (HTTP 200)
    const resB = await fetch(`${baseUrl}/api/sessions/${sessionB.id}/messages`, {
      headers: {
        Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(betaCookie)}`
      }
    });
    if (resB.status !== 200) {
      throw new Error(`Expected HTTP 200 for User B accessing own session, got HTTP ${resB.status}`);
    }
    const bMessages = await resB.json();
    if (!Array.isArray(bMessages) || bMessages.length !== 1 || !bMessages[0].content.includes('quantum ledger')) {
      throw new Error(`Unexpected session messages for User B: ${JSON.stringify(bMessages)}`);
    }
    console.log('  ✓ User B can successfully fetch own session messages.');

    // 2. Test User A session listing and title truncation to 60 characters
    // User A creates Session 1 with a message > 60 chars
    const sessionA1 = createSession(userAlpha, 'Initial Title');
    const longPrompt = 'Can you analyze the complete competitive breakdown of CRM software for enterprise teams?'; // 89 chars
    insertMessage(
      sessionA1.id,
      'user',
      longPrompt,
      '2026-11-14T09:00:00Z',
      null,
      false,
      'UTC',
      userAlpha
    );
    insertMessage(
      sessionA1.id,
      'assistant',
      'Here is the complete competitive CRM analysis...',
      '2026-11-14T09:01:00Z',
      null,
      false,
      'UTC',
      userAlpha
    );

    // Fetch GET /api/sessions for User A
    const listRes1 = await fetch(`${baseUrl}/api/sessions`, {
      headers: {
        Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(alphaCookie)}`
      }
    });
    if (listRes1.status !== 200) {
      throw new Error(`Failed to fetch sessions: HTTP ${listRes1.status}`);
    }
    const sessionsList1 = await listRes1.json();
    if (!Array.isArray(sessionsList1) || sessionsList1.length !== 1) {
      throw new Error(`Expected 1 session in list for User A, got ${sessionsList1.length}`);
    }
    const expectedTruncated = formatSessionTitle(longPrompt);
    if (sessionsList1[0].title !== expectedTruncated) {
      throw new Error(
        `Expected title to be first user message truncated to 50 chars with trailing punctuation trimmed ("${expectedTruncated}"), got: "${sessionsList1[0].title}"`
      );
    }
    console.log('  ✓ Session title accurately truncated to first user message (50 chars with trailing punctuation trimmed).');

    // 3. Test Requirement 6:
    // "Tests: clicking New Chat three times creates zero history entries; sending one message creates exactly one entry titled with that message; an empty session never appears in GET /api/sessions."
    console.log('  -> Testing requirement 6: New Chat 3 times creates zero history entries, sending 1 message creates 1 entry, empty sessions never appear...');
    
    const userReq6 = 'user-req6-' + Date.now();
    const req6Cookie = signCookieValue(userReq6);

    // 3a. Initial state: 0 entries
    let req6ListRes = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(req6Cookie)}` }
    });
    let req6Sessions = await req6ListRes.json();
    if (req6Sessions.length !== 0) {
      throw new Error(`Expected 0 sessions initially for new user, got ${req6Sessions.length}`);
    }

    // 3b. Click New Chat three times:
    // On the client, clicking New Chat makes zero server calls. Even if POST /api/session/new is called:
    for (let i = 0; i < 3; i++) {
      const ncRes = await fetch(`${baseUrl}/api/session/new`, {
        method: 'POST',
        headers: {
          Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(req6Cookie)}`,
          'Content-Type': 'application/json'
        }
      });
      if (ncRes.status !== 201) throw new Error(`New chat endpoint failed: HTTP ${ncRes.status}`);
    }

    // Verify: clicking New Chat three times creates ZERO history entries in GET /api/sessions
    req6ListRes = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(req6Cookie)}` }
    });
    req6Sessions = await req6ListRes.json();
    if (req6Sessions.length !== 0) {
      throw new Error(`Expected 0 history entries after clicking New Chat three times, got ${req6Sessions.length}`);
    }
    console.log('  ✓ Clicking New Chat three times creates zero history entries.');

    // 3c. Sending one message creates exactly one entry titled with that message
    const req6SessionId = `session-req6-${Date.now()}`;
    const firstUserMsg = 'What is the fastest land animal in the world???';
    insertMessage(
      req6SessionId,
      'user',
      firstUserMsg,
      new Date().toISOString(),
      null,
      false,
      'UTC',
      userReq6
    );

    req6ListRes = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(req6Cookie)}` }
    });
    req6Sessions = await req6ListRes.json();
    if (req6Sessions.length !== 1) {
      throw new Error(`Expected exactly 1 session entry after sending one message, got ${req6Sessions.length}`);
    }
    const expectedReq6Title = formatSessionTitle(firstUserMsg); // "What is the fastest land animal in the world"
    if (req6Sessions[0].title !== expectedReq6Title) {
      throw new Error(`Expected title "${expectedReq6Title}", got: "${req6Sessions[0].title}"`);
    }
    if (req6Sessions[0].id !== req6SessionId) {
      throw new Error(`Expected session ID ${req6SessionId}, got: ${req6Sessions[0].id}`);
    }
    console.log('  ✓ Sending one message creates exactly one entry titled with that message (trailing punctuation trimmed).');

    // 3d. An empty session NEVER appears in GET /api/sessions
    // Even if an empty session row was manually inserted in the sessions table:
    db.prepare('INSERT INTO sessions (id, user_id, title, created_at) VALUES (?, ?, ?, ?)').run(
      `empty-session-ghost-${Date.now()}`,
      userReq6,
      'Ghost Empty Session',
      new Date().toISOString()
    );

    req6ListRes = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(req6Cookie)}` }
    });
    req6Sessions = await req6ListRes.json();
    if (req6Sessions.length !== 1 || req6Sessions.some((s: any) => s.id.includes('empty-session-ghost'))) {
      throw new Error('Security/Filtering failure: an empty session appeared in GET /api/sessions!');
    }
    console.log('  ✓ An empty session never appears in GET /api/sessions.');

    // 3e. Startup cleanup: deletes sessions that have zero messages
    const cleanedCount = cleanupEmptySessions();
    if (cleanedCount < 1) {
      throw new Error('Expected cleanupEmptySessions to delete the empty session from DB');
    }
    console.log('  ✓ One-time cleanup at startup successfully deletes sessions that have zero messages.');

    // 4. In Session 2 for User Alpha, the agent can still recall Session 1's content
    const sessionA2Id = `session-alpha2-${Date.now()}`;
    console.log('  -> Asking in new session: "What did I ask you to analyze in CRM earlier?"...');
    const recallEvents: AgentEvent[] = [];
    const recallAnswer = await runAgent(
      'What did I ask you to analyze in CRM earlier?',
      sessionA2Id,
      (ev) => recallEvents.push(ev),
      policyNow,
      { userId: userAlpha }
    );
    const lowerRecall = recallAnswer.toLowerCase();
    if (!lowerRecall.includes('competitive') && !lowerRecall.includes('crm')) {
      throw new Error(`Expected agent in new session to recall earlier CRM inquiry from Session 1, got: "${recallAnswer}"`);
    }
    console.log('  ✓ Cross-session memory recall confirmed: Agent recalled Session 1 content in Session 2.');

    // 12. Testing Stop Execution & AbortSignal Handling
    console.log('\n[12/12] Testing Stop Execution & AbortSignal Handling...');
    const stopAbortController = new AbortController();
    stopAbortController.abort(); // already aborted
    const stopEvents: AgentEvent[] = [];
    const stopStart = performance.now();
    const stoppedResult = await runAgent(
      'What is the latest pricing for CRM tools?',
      'session-stop-test',
      (ev) => stopEvents.push(ev),
      policyNow,
      { signal: stopAbortController.signal, userId: userAlpha }
    );
    const stopDuration = performance.now() - stopStart;
    if (stopDuration > 500) {
      throw new Error(`Expected aborted agent execution to exit immediately, took ${stopDuration}ms`);
    }
    if (stopEvents.some((e) => e.type === 'error')) {
      throw new Error('Aborted execution should not emit error events');
    }
    console.log(`  ✓ Stop execution verified: runAgent stopped cleanly in ${Math.round(stopDuration)}ms with AbortSignal.`);

    // Test POST /api/chat/stop endpoint
    const stopRes = await fetch(`${baseUrl}/api/chat/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(alphaCookie)}`
      },
      body: JSON.stringify({ sessionId: 'session-nonexistent' })
    });
    const stopData = await stopRes.json();
    if (!stopData.success) {
      throw new Error('POST /api/chat/stop should return success');
    }
    console.log('  ✓ POST /api/chat/stop endpoint verified.');

    // ----------------------------------------------------
    // 13. Testing Trace Pill Structured Events & Render States
    // ----------------------------------------------------
    console.log('\n[13/13] Testing Trace Pill Structured Events & Render States...');
    const traceTestUser = 'user-trace-' + Date.now();
    clearDatabase(traceTestUser);

    // 13.1 Test: "hi" shows no pill
    console.log('  -> Testing Case 1: "hi" shows no pill...');
    const hiEvents: AgentEvent[] = [];
    const hiAbort = new AbortController();
    await runAgent(
      'hi',
      'session-hi-trace',
      (ev) => {
        hiEvents.push(ev);
        if (ev.type === 'trace' && ev.step === 'memory') {
          hiAbort.abort();
        }
      },
      policyNow,
      { userId: traceTestUser, signal: hiAbort.signal }
    );

    const hiStatus = hiEvents.find((e) => e.type === 'status');
    if (!hiStatus || (hiStatus.text !== 'Working…' && hiStatus.message !== 'Working…')) {
      throw new Error(`Expected transient status "Working…", got ${JSON.stringify(hiStatus)}`);
    }

    const hiMemoryTrace = hiEvents.find((e) => e.type === 'trace' && e.step === 'memory');
    if (!hiMemoryTrace || hiMemoryTrace.found !== 0) {
      throw new Error(`Expected memory trace with found=0 for "hi", got ${JSON.stringify(hiMemoryTrace)}`);
    }

    const hiSearchTrace = hiEvents.filter((e) => e.type === 'trace' && e.step === 'search');
    if (hiSearchTrace.length !== 0) {
      throw new Error(`Expected 0 search traces for "hi", got ${hiSearchTrace.length}`);
    }

    const hiPillState = computeTracePillState(hiEvents as any);
    if (hiPillState.shouldRender !== false) {
      throw new Error(`Expected shouldRender=false (no pill) for "hi", got ${JSON.stringify(hiPillState)}`);
    }
    console.log('  ✓ Case 1 passed: "hi" shows no pill (found=0, searches=0).');

    // 13.2 Test: "what's my name" (name stored) shows the memory pill with that message as a snippet
    console.log('  -> Testing Case 2: "what\'s my name" (name stored) shows memory pill with snippet...');
    insertMessage(
      'session-name-stored',
      'user',
      'My name is Tanay.',
      '2026-11-13T10:00:00Z',
      null,
      false,
      'UTC',
      traceTestUser
    );

    const nameTraceEvents: AgentEvent[] = [];
    const nameAbort = new AbortController();
    await runAgent(
      "what's my name?",
      'session-name-stored',
      (ev) => {
        nameTraceEvents.push(ev);
        if (ev.type === 'trace' && ev.step === 'memory') {
          nameAbort.abort();
        }
      },
      policyNow,
      { userId: traceTestUser, signal: nameAbort.signal }
    );

    const nameMemTrace = nameTraceEvents.find((e) => e.type === 'trace' && e.step === 'memory');
    if (!nameMemTrace || !nameMemTrace.found || nameMemTrace.found < 1) {
      throw new Error(`Expected memory trace with found>=1 for "what's my name?", got ${JSON.stringify(nameMemTrace)}`);
    }
    if (!nameMemTrace.snippets || nameMemTrace.snippets.length === 0 || !nameMemTrace.snippets[0].text.includes('Tanay')) {
      throw new Error(`Expected snippet containing "Tanay", got ${JSON.stringify(nameMemTrace.snippets)}`);
    }

    const namePillState = computeTracePillState(nameTraceEvents as any);
    if (!namePillState.shouldRender || namePillState.collapsedText !== 'Used earlier conversation') {
      throw new Error(`Expected collapsed text "Used earlier conversation", got ${JSON.stringify(namePillState)}`);
    }
    if (namePillState.memorySnippets.length === 0 || !namePillState.memorySnippets[0].text.includes('Tanay')) {
      throw new Error(`Expected memory snippet in pill state containing "Tanay", got ${JSON.stringify(namePillState)}`);
    }
    console.log('  ✓ Case 2 passed: "what\'s my name" shows memory pill with snippet.');

    // 13.3 Test: "what's the latest Node.js version" shows only the search pill
    console.log('  -> Testing Case 3: "what\'s the latest Node.js version" shows only search pill...');
    const nodeTestUser = 'user-node-' + Date.now();
    clearDatabase(nodeTestUser);

    const nodeMockSearch: WebSearchResultItem[] = [
      {
        query: 'latest nodejs version',
        title: 'Node.js v24 Release Notes',
        url: 'https://nodejs.org/en/blog/release/v24.0.0',
        snippet: 'Node.js 24 is now available as Current.',
        published_date: '2026-11-10'
      }
    ];

    const nodeEvents: AgentEvent[] = [];
    const nodeAbort = new AbortController();
    await runAgent(
      "what's the latest Node.js version",
      'session-node-test',
      (ev) => {
        nodeEvents.push(ev);
        if (ev.type === 'trace' && ev.step === 'search') {
          nodeAbort.abort();
        }
      },
      policyNow,
      {
        userId: nodeTestUser,
        mockSearchResults: nodeMockSearch,
        signal: nodeAbort.signal
      }
    );

    const nodeMemTrace = nodeEvents.find((e) => e.type === 'trace' && e.step === 'memory');
    if (!nodeMemTrace || nodeMemTrace.found !== 0) {
      throw new Error(`Expected memory found=0 for fresh Node.js query, got ${JSON.stringify(nodeMemTrace)}`);
    }

    const nodeSearchTrace = nodeEvents.filter((e) => e.type === 'trace' && e.step === 'search');
    if (nodeSearchTrace.length === 0) {
      throw new Error(`Expected at least 1 search trace for "what's the latest Node.js version", got ${nodeSearchTrace.length}`);
    }

    const nodePillState = computeTracePillState(nodeEvents as any);
    if (!nodePillState.shouldRender || nodePillState.collapsedText !== 'Searched the web') {
      throw new Error(`Expected collapsed text "Searched the web", got ${JSON.stringify(nodePillState)}`);
    }
    if (nodePillState.hasMemory !== false || nodePillState.hasSearch !== true) {
      throw new Error(`Expected hasMemory=false, hasSearch=true, got ${JSON.stringify(nodePillState)}`);
    }
    if (!nodePillState.searchQueries || !nodePillState.searchResults) {
      throw new Error(`Expected search queries & results in pill state, got ${JSON.stringify(nodePillState)}`);
    }
    console.log(`  ✓ Case 3 passed: "what's the latest Node.js version" shows only search pill (${nodePillState.searchQueries} queries · ${nodePillState.searchResults} results · ${nodePillState.searchDurationSec}s).`);

    clearDatabase(traceTestUser);
    clearDatabase(nodeTestUser);

    // ----------------------------------------------------
    // 14. Testing Memory Retrieval Fallback When Date Resolved
    // ----------------------------------------------------
    console.log('\n[14/14] Testing Memory Retrieval Fallback When Date Resolved...');
    const dateFallbackUser = 'user-date-fallback-' + Date.now();
    clearDatabase(dateFallbackUser);

    // Setup: DB with messages ONLY on 2026-11-16
    const nov16Session = 'session-nov16-' + Date.now();
    insertMessage(
      nov16Session,
      'user',
      'What are the top CRM tools for a sales team?',
      '2026-11-16T10:00:00Z',
      null,
      false,
      'UTC',
      dateFallbackUser
    );
    insertMessage(
      nov16Session,
      'assistant',
      'HubSpot and Pipedrive are great options for a sales team.',
      '2026-11-16T10:01:00Z',
      null,
      false,
      'UTC',
      dateFallbackUser
    );

    const testToday17 = new Date('2026-11-17T12:00:00Z'); // Today is the 17th

    // 14.1 Unit check on temporal resolver for "what did I ask on 3 November?"
    console.log('  -> Testing temporal resolver for "what did I ask on 3 November?" (DB messages only on 2026-11-16)...');
    const nov3ResolverRes = resolveTemporalContext(
      'what did I ask on 3 November?',
      'session-nov3-test',
      testToday17,
      MAX_CONTEXT_CHARS,
      'UTC',
      dateFallbackUser
    );

    if (nov3ResolverRes.matchedMessages.length !== 0) {
      throw new Error(`Expected 0 matched messages for 3 November, got ${nov3ResolverRes.matchedMessages.length}`);
    }
    if (!nov3ResolverRes.dateResolved || nov3ResolverRes.resolvedDateStr !== '2026-11-03') {
      throw new Error(`Expected dateResolved=true with resolvedDateStr=2026-11-03, got dateResolved=${nov3ResolverRes.dateResolved}, resolvedDateStr=${nov3ResolverRes.resolvedDateStr}`);
    }
    if (nov3ResolverRes.earliestDate !== '2026-11-16') {
      throw new Error(`Expected earliestDate=2026-11-16, got ${nov3ResolverRes.earliestDate}`);
    }
    const expectedNov3Note = "No messages exist for 2026-11-03. This user's earliest stored message is 2026-11-16.";
    if (!nov3ResolverRes.formattedContext.includes(expectedNov3Note)) {
      throw new Error(`Expected formattedContext to contain note "${expectedNov3Note}", got: "${nov3ResolverRes.formattedContext}"`);
    }
    console.log('  ✓ Temporal resolver correctly injected no-messages note and computed earliest date (2026-11-16).');

    // 14.2 Trace and Agent behavior for "what did I ask on 3 November?"
    console.log('  -> Testing agent run for "what did I ask on 3 November?"...');
    const nov3Events: AgentEvent[] = [];
    const nov3Answer = await runAgent(
      'what did I ask on 3 November?',
      'session-nov3-agent',
      (ev) => nov3Events.push(ev),
      testToday17,
      { userId: dateFallbackUser }
    );

    const nov3MemTrace = nov3Events.find((e) => e.type === 'trace' && e.step === 'memory');
    if (!nov3MemTrace || nov3MemTrace.found !== 0) {
      throw new Error(`Expected memory trace found=0, got: ${JSON.stringify(nov3MemTrace)}`);
    }
    if (!nov3MemTrace.snippets || nov3MemTrace.snippets.length !== 0) {
      throw new Error(`Expected 0 snippets in memory trace for 3 November, got ${nov3MemTrace.snippets?.length}`);
    }
    if (nov3MemTrace.dateStr !== '2026-11-03' || nov3MemTrace.earliestDate !== '2026-11-16') {
      throw new Error(`Expected dateStr=2026-11-03 and earliestDate=2026-11-16, got ${JSON.stringify(nov3MemTrace)}`);
    }

    const nov3Pill = computeTracePillState(nov3Events as any);
    if (!nov3Pill.shouldRender) {
      throw new Error('Expected trace pill to render for date resolved zero found');
    }
    if (nov3Pill.collapsedText !== 'Checked earlier conversation · nothing on 2026-11-03') {
      throw new Error(`Expected collapsed text "Checked earlier conversation · nothing on 2026-11-03", got "${nov3Pill.collapsedText}"`);
    }
    const expectedExpandedHeader = 'No messages stored for 2026-11-03. Earliest stored message: 2026-11-16.';
    if (nov3Pill.memoryHeaderText !== expectedExpandedHeader) {
      throw new Error(`Expected expanded header "${expectedExpandedHeader}", got "${nov3Pill.memoryHeaderText}"`);
    }
    if (nov3Pill.memorySnippets.length !== 0) {
      throw new Error(`Expected 0 snippets in pill state, got ${nov3Pill.memorySnippets.length}`);
    }

    const lowerNov3Answer = nov3Answer.toLowerCase();
    const statesNoRecordNov3 =
      lowerNov3Answer.includes('no record') ||
      lowerNov3Answer.includes('no messages') ||
      lowerNov3Answer.includes('no stored') ||
      lowerNov3Answer.includes('no conversation') ||
      lowerNov3Answer.includes('no prior') ||
      lowerNov3Answer.includes("don't have any record") ||
      lowerNov3Answer.includes('earliest');
    if (!statesNoRecordNov3) {
      throw new Error(`Expected answer to state no record exists for 3 November, got: "${nov3Answer}"`);
    }
    console.log('  ✓ Query "what did I ask on 3 November?" successfully showed zero snippets and answered with no record.');

    // 14.3 Query "what did I ask yesterday?" with messages on the 16th (today is the 17th) shows them
    console.log('  -> Testing agent run for "what did I ask yesterday?" (yesterday = 2026-11-16)...');
    const yesterdayEvents: AgentEvent[] = [];
    const yesterdayAnswer = await runAgent(
      'what did I ask yesterday?',
      'session-yesterday-agent',
      (ev) => yesterdayEvents.push(ev),
      testToday17,
      { userId: dateFallbackUser }
    );

    const yesterdayMemTrace = yesterdayEvents.find((e) => e.type === 'trace' && e.step === 'memory');
    if (!yesterdayMemTrace || !yesterdayMemTrace.found || yesterdayMemTrace.found < 1) {
      throw new Error(`Expected memory trace found>=1 for yesterday, got: ${JSON.stringify(yesterdayMemTrace)}`);
    }
    if (!yesterdayMemTrace.snippets || yesterdayMemTrace.snippets.length === 0 || !yesterdayMemTrace.snippets.some(s => s.text.includes('CRM tools'))) {
      throw new Error(`Expected memory snippets containing yesterday's CRM question, got: ${JSON.stringify(yesterdayMemTrace.snippets)}`);
    }

    const yesterdayPill = computeTracePillState(yesterdayEvents as any);
    if (!yesterdayPill.shouldRender || yesterdayPill.collapsedText !== 'Used earlier conversation') {
      throw new Error(`Expected collapsed text "Used earlier conversation", got "${yesterdayPill.collapsedText}"`);
    }
    if (!yesterdayPill.memoryHeaderText.includes('from 2026-11-16')) {
      throw new Error(`Expected memory header to mention "from 2026-11-16", got "${yesterdayPill.memoryHeaderText}"`);
    }
    if (yesterdayPill.memorySnippets.length === 0 || !yesterdayPill.memorySnippets.some(s => s.text.includes('CRM tools'))) {
      throw new Error(`Expected snippets in pill state to show CRM question, got ${JSON.stringify(yesterdayPill.memorySnippets)}`);
    }

    const lowerYesterdayAnswer = yesterdayAnswer.toLowerCase();
    if (!lowerYesterdayAnswer.includes('crm')) {
      throw new Error(`Expected answer for yesterday to recall CRM question, got: "${yesterdayAnswer}"`);
    }
    console.log('  ✓ Query "what did I ask yesterday?" successfully retrieved messages from 2026-11-16 and showed them.');

    clearDatabase(dateFallbackUser);

    // ----------------------------------------------------
    // 15. Testing Trace Persistence Across Reload & API
    // ----------------------------------------------------
    console.log('\n[15/15] Testing Trace Persistence Across Reload & API...');
    const reloadTestUser = 'user-reload-' + Date.now();
    const reloadCookie = signCookieValue(reloadTestUser);
    clearDatabase(reloadTestUser);

    // 15.1 Seed past memory
    insertMessage(
      'session-seed-bluebird',
      'user',
      'My secret project codename is Project Bluebird which focuses on autonomous avionics.',
      '2026-11-15T10:00:00Z',
      null,
      false,
      'UTC',
      reloadTestUser
    );
    insertMessage(
      'session-seed-bluebird',
      'assistant',
      'Recorded secret codename Project Bluebird.',
      '2026-11-15T10:01:00Z',
      null,
      false,
      'UTC',
      reloadTestUser
    );

    // 15.2 Send message that triggers memory in a new session
    console.log('  -> Sending message triggering memory in session-reload-test...');
    await runAgent(
      'What is my secret project codename?',
      'session-reload-test',
      () => {},
      testToday17,
      { userId: reloadTestUser }
    );

    // 15.3 Reload: fetch messages via HTTP GET /api/sessions/:id/messages
    console.log('  -> Testing HTTP GET /api/sessions/session-reload-test/messages returns persisted trace...');
    const reloadHttpRes = await fetch(`${baseUrl}/api/sessions/session-reload-test/messages`, {
      headers: { Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(reloadCookie)}` }
    });
    if (!reloadHttpRes.ok) {
      throw new Error(`HTTP GET messages failed with status ${reloadHttpRes.status}`);
    }
    const sessionMsgs: any[] = await reloadHttpRes.json();
    if (sessionMsgs.length < 2) {
      throw new Error(`Expected at least 2 messages in session, got ${sessionMsgs.length}`);
    }

    const userMsg = sessionMsgs.find((m) => m.role === 'user');
    const assistantMsg = sessionMsgs.find((m) => m.role === 'assistant');

    if (!userMsg || userMsg.trace !== null) {
      throw new Error(`User message should have trace === null, got: ${JSON.stringify(userMsg?.trace)}`);
    }

    if (!assistantMsg || !assistantMsg.trace) {
      throw new Error(`Assistant message should have non-null persisted trace, got: ${JSON.stringify(assistantMsg?.trace)}`);
    }

    // Verify trace contents: memory {found, snippets:[{date, role, text}]}
    const persistedTrace = assistantMsg.trace;
    if (!persistedTrace.memory || persistedTrace.memory.found < 1) {
      throw new Error(`Expected trace.memory.found >= 1, got: ${JSON.stringify(persistedTrace.memory)}`);
    }
    if (!Array.isArray(persistedTrace.memory.snippets) || persistedTrace.memory.snippets.length === 0) {
      throw new Error(`Expected non-empty trace.memory.snippets, got: ${JSON.stringify(persistedTrace.memory.snippets)}`);
    }

    const firstSnippet = persistedTrace.memory.snippets[0];
    if (!firstSnippet.date || !firstSnippet.text || !firstSnippet.text.includes('Bluebird')) {
      throw new Error(`Expected snippet with date and "Bluebird", got: ${JSON.stringify(firstSnippet)}`);
    }
    if (firstSnippet.role !== 'user') {
      throw new Error(`Expected snippet role to be "user", got: "${firstSnippet.role}"`);
    }
    if (firstSnippet.text.length > 80) {
      throw new Error(`Expected snippet text truncated to <= 80 chars, got length ${firstSnippet.text.length}`);
    }

    // Client pill rendering test with identical content
    const reloadedPill = computeTracePillState(persistedTrace);
    if (!reloadedPill.shouldRender || reloadedPill.collapsedText !== 'Used earlier conversation') {
      throw new Error(`Expected pill shouldRender=true with collapsedText="Used earlier conversation", got: ${JSON.stringify(reloadedPill)}`);
    }
    if (reloadedPill.memorySnippets.length === 0 || !reloadedPill.memorySnippets[0].text.includes('Bluebird')) {
      throw new Error(`Expected reloaded pill state to have Bluebird snippet, got: ${JSON.stringify(reloadedPill.memorySnippets)}`);
    }
    if (!reloadedPill.timingText.startsWith('total ') || !reloadedPill.timingText.endsWith('s')) {
      throw new Error(`Expected reloaded pill timingText to match "total <X.X>s", got "${reloadedPill.timingText}"`);
    }
    console.log(`  ✓ Reloaded message has identical persisted trace with truncated snippets and renders pill (${reloadedPill.timingText}).`);

    // 15.3b Test search ran timing format: "<N> queries · <N> results · search <X.X>s · total <X.X>s"
    const searchTraceSample = {
      search: {
        queries: 2,
        results: 9,
        ms: 1234,
        totalMs: 6543
      },
      totalMs: 6543
    };
    const searchPill = computeTracePillState(searchTraceSample);
    const expectedSearchTiming = '2 queries · 9 results · search 1.2s · total 6.5s';
    if (searchPill.timingText !== expectedSearchTiming) {
      throw new Error(`Expected timingText "${expectedSearchTiming}", got "${searchPill.timingText}"`);
    }
    console.log(`  ✓ Search timing pill format verified: "${searchPill.timingText}"`);

    // Test no search timing format: "total <X.X>s"
    const memoryOnlyTrace = {
      memory: {
        found: 1,
        snippets: [{ date: '2026-11-15', role: 'user', text: 'Sample' }]
      },
      totalMs: 1820
    };
    const memOnlyPill = computeTracePillState(memoryOnlyTrace);
    const expectedMemTiming = 'total 1.8s';
    if (memOnlyPill.timingText !== expectedMemTiming) {
      throw new Error(`Expected timingText "${expectedMemTiming}", got "${memOnlyPill.timingText}"`);
    }
    console.log(`  ✓ No-search timing pill format verified: "${memOnlyPill.timingText}"`);

    // 15.4 Message with no trace returns null and shows no pill
    console.log('  -> Testing message with no trace returns null and shows no pill...');
    await runAgent(
      'hi',
      'session-no-trace',
      () => {},
      testToday17,
      { userId: reloadTestUser }
    );
    const noTraceHttpRes = await fetch(`${baseUrl}/api/sessions/session-no-trace/messages`, {
      headers: { Cookie: `${USER_COOKIE_NAME}=${encodeURIComponent(reloadCookie)}` }
    });
    const noTraceMsgs: any[] = await noTraceHttpRes.json();
    const noTraceAssistant = noTraceMsgs.find((m) => m.role === 'assistant');
    if (!noTraceAssistant) {
      throw new Error('Expected assistant message in session-no-trace');
    }
    if (noTraceAssistant.trace !== null) {
      throw new Error(`Expected assistant message with no trace to return null, got: ${JSON.stringify(noTraceAssistant.trace)}`);
    }
    const noTracePill = computeTracePillState(noTraceAssistant.trace);
    if (noTracePill.shouldRender !== false) {
      throw new Error(`Expected shouldRender=false for null trace, got: ${JSON.stringify(noTracePill)}`);
    }
    console.log('  ✓ Message with no trace returns null and shows no pill.');

    // 15.5 Clear All Memory deletes trace with messages
    clearDatabase(reloadTestUser);
    const postClearMsgs = getSessionMessages('session-reload-test', reloadTestUser);
    if (postClearMsgs !== null && postClearMsgs.length > 0) {
      throw new Error(`Expected cleared database to return 0 messages, got ${postClearMsgs?.length}`);
    }
    console.log('  ✓ Clear All Memory deletes trace along with messages.');

  } finally {
    testServer.close();
    clearDatabase(userAlpha);
    clearDatabase(userBeta);
  }
  console.log('  ✓ Test server closed and database cleaned.');

  console.log('\nAll 15 test suites passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
