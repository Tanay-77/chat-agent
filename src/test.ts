import { seedDatabase } from './db/seed.js';
import {
  db,
  insertMessage,
  getRecentMessages,
  searchMessagesByDateRange,
  searchMessagesByKeyword,
  getDatabaseStats,
  getAllMessages,
  clearDatabase,
  isDatabaseEmpty
} from './db/memory.js';
import { resolveTemporalContext } from './context/temporalResolver.js';
import { webSearchToolDeclaration, executeWebSearch } from './tools/webSearch.js';
import { buildCalendarReference, buildSystemPrompt, runAgent, AgentEvent } from './agent/runner.js';

async function runTests() {
  console.log('=== Running Chat Agent Verification Suite ===\n');

  // 1. Seed & Memory Tests (with is_demo validation)
  console.log('[1/6] Testing Persistent Memory, Demo Tagging & Database Clearing...');
  const seedResult = seedDatabase(true);
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

  // Range and keyword queries
  const novRange = searchMessagesByDateRange(null, '2026-11-01', '2026-11-05');
  if (novRange.length !== 2) throw new Error('Date range query failed');

  const postgresKw = searchMessagesByKeyword(null, 'Postgres');
  if (postgresKw.length !== 2) throw new Error('Keyword search failed');

  const recent = getRecentMessages('session-monday-crm', 10);
  if (recent.length !== 2) throw new Error('Recent messages query failed');

  console.log('Memory layer tests & is_demo verification passed.');

  // 2. Temporal Context Resolution Tests
  console.log('\n[2/6] Testing Temporal Context Assembler...');

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

  console.log('Temporal resolver tests passed.');

  // 3. Calendar Reference & System Prompt Verification
  console.log('\n[3/6] Testing Calendar Reference & System Prompt Builder...');
  const now = new Date('2026-11-12T12:00:00Z');
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
  console.log('Calendar reference & system prompt generation verified.');

  // 4. Web Search Tool Schema Tests
  console.log('\n[4/6] Testing Web Search Tool Schema...');
  if (webSearchToolDeclaration.name !== 'web_search') {
    throw new Error('Tool name must be web_search');
  }
  if (!webSearchToolDeclaration.parameters?.properties?.queries) {
    throw new Error('Tool schema missing queries parameter');
  }
  console.log('Web search tool schema valid.');

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
