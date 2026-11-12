import { seedDatabase } from './db/seed.js';
import {
  db,
  insertMessage,
  getRecentMessages,
  searchMessagesByDateRange,
  searchMessagesByKeyword,
  getDatabaseStats
} from './db/memory.js';
import { resolveTemporalContext } from './context/temporalResolver.js';
import { webSearchToolDeclaration, executeWebSearch } from './tools/webSearch.js';

async function runTests() {
  console.log('=== Running Chat Agent Verification Suite ===\n');

  // 1. Seed & Memory Tests
  console.log('[1/4] Testing Persistent Memory & Dynamic Seed...');
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
  console.log('\n[2/4] Testing Temporal Context Assembler...');

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

  // 3. Web Search Tool Schema Tests
  console.log('\n[3/4] Testing Web Search Tool Schema...');
  if (webSearchToolDeclaration.name !== 'web_search') {
    throw new Error('Tool name must be web_search');
  }
  if (!webSearchToolDeclaration.parameters.properties.queries) {
    throw new Error('Tool schema missing queries parameter');
  }
  console.log('Web search tool schema valid.');

  // 4. Web Search Execution Safety
  console.log('\n[4/4] Testing Web Search Execution Safety...');
  const searchResults = await executeWebSearch({
    queries: ['Next.js release notes', 'Anthropic Claude token pricing'],
    days_back: 7
  });
  console.log(`Web search handled safely (returned ${searchResults.length} items).`);

  console.log('\nAll tests passed successfully!');
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});

