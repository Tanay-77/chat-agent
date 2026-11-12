import { seedDatabase } from './db/seed.js';
import {
  db,
  insertMessage,
  getRecentMessages,
  searchMessagesByDateRange,
  searchMessagesByKeyword,
  getDatabaseStats,
  getAllMessages
} from './db/memory.js';
import { resolveTemporalContext } from './context/temporalResolver.js';
import { webSearchToolDeclaration, executeWebSearch } from './tools/webSearch.js';
import { buildCalendarReference, buildSystemPrompt, runAgent, AgentEvent } from './agent/runner.js';

async function runTests() {
  console.log('=== Running Chat Agent Verification Suite ===\n');

  // 1. Seed & Memory Tests
  console.log('[1/5] Testing Persistent Memory & Dynamic Seed...');
  const seedResult = seedDatabase(true);
  if (seedResult.messages.length !== 6) {
    throw new Error(`Expected 6 seeded messages, got ${seedResult.messages.length}`);
  }

  const stats = getDatabaseStats();
  if (stats.totalMessages !== 6 || stats.sessionsCount !== 3 || stats.datesCount !== 3) {
    throw new Error(`Unexpected stats: ${JSON.stringify(stats)}`);
  }

  // Range and keyword queries
  const novRange = searchMessagesByDateRange(null, '2026-11-01', '2026-11-05');
  if (novRange.length !== 2) throw new Error('Date range query failed');

  const postgresKw = searchMessagesByKeyword(null, 'Postgres');
  if (postgresKw.length !== 2) throw new Error('Keyword search failed');

  const recent = getRecentMessages('session-monday-crm', 10);
  if (recent.length !== 2) throw new Error('Recent messages query failed');

  console.log('Memory layer tests passed.');

  // 2. Temporal Context Resolution Tests
  console.log('\n[2/5] Testing Temporal Context Assembler...');

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
  console.log('\n[3/5] Testing Calendar Reference & System Prompt Builder...');
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
  console.log('Calendar reference & system prompt generation verified.');

  // 4. Web Search Tool Schema Tests
  console.log('\n[4/5] Testing Web Search Tool Schema...');
  if (webSearchToolDeclaration.name !== 'web_search') {
    throw new Error('Tool name must be web_search');
  }
  if (!webSearchToolDeclaration.parameters?.properties?.queries) {
    throw new Error('Tool schema missing queries parameter');
  }
  console.log('Web search tool schema valid.');

  // 5. Agent Loop & History Verification
  console.log('\n[5/5] Testing Agent Loop & Grouped History Structure...');
  const events: AgentEvent[] = [];
  const testSession = 'test-session-agent';

  // Test runAgent (should handle gracefully if key is not yet set, or run if set)
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

  // Cleanup test session
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(testSession);

  console.log('\nAll tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
