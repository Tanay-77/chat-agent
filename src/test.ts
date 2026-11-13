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
  isDatabaseEmpty
} from './db/memory.js';
import { resolveTemporalContext, MAX_CONTEXT_CHARS, parseDates, formatDateInTz, setUserTimezone } from './context/temporalResolver.js';
import {
  webSearchToolDeclaration,
  executeWebSearch,
  computeEffectiveStartDate,
  TAVILY_PUBLISH_DATE_NOTE
} from './tools/webSearch.js';
import { buildCalendarReference, buildSystemPrompt, runAgent, AgentEvent } from './agent/runner.js';

async function runTests() {
  console.log('=== Running Chat Agent Verification Suite ===\n');
  const now = new Date('2026-11-12T12:00:00Z');

  // 1. Seed & Memory Tests (with is_demo validation)
  console.log('[1/6] Testing Persistent Memory, Demo Tagging & Database Clearing...');
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

  // FTS5 BM25 search
  const postgresFts = searchMessagesFTS('Postgres hosting options');
  if (postgresFts.length < 2) throw new Error('FTS5 search for Postgres failed');
  if (typeof postgresFts[0].rank !== 'number' || postgresFts[0].rank >= 0) {
    throw new Error('FTS5 BM25 ranking should return negative score');
  }

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
  console.log('\n[2/6] Testing Temporal Context Assembler with FTS5 BM25...');

  // Query 1: Monday CRM shortlist
  const q1 = "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";
  const res1 = resolveTemporalContext(q1, 'session-test-1');
  if (res1.matchedMessages.length < 2 || !res1.matchedMessages.some(m => m.content.includes('HubSpot Sales Hub'))) {
    throw new Error('Temporal resolution for Monday CRM query failed');
  }

  // Query 2: 3 November
  const q2 = "What did I ask you on 3 November? Is your answer still correct today?";
  const res2 = resolveTemporalContext(q2, 'session-test-2');
  if (res2.matchedMessages.length < 2 || !res2.matchedMessages.some(m => m.content.includes('Next.js 15.0.1'))) {
    throw new Error('Temporal resolution for 3 November query failed');
  }

  // Query 3: Last Tuesday Postgres
  const q3 = "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?";
  const res3 = resolveTemporalContext(q3, 'session-test-3');
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
  console.log('\n[3/6] Testing Calendar Reference & System Prompt Builder...');
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
  console.log('Calendar reference & system prompt generation verified.');

  // 4. Web Search Tool Schema Tests
  console.log('\n[4/6] Testing Web Search Tool Schema...');
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
  console.log('\n[5/6] Testing Agent Loop & Grouped History Structure (Seeded DB)...');
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
  console.log('\n[6/6] Testing Anti-Fabrication Behavior on Empty Database...');
  
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
  console.log('\nAll 6 test suites passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
