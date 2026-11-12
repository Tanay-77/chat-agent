import {
  db,
  insertMessage,
  getRecentMessages,
  searchMessagesByDateRange,
  searchMessagesByKeyword,
  getDatabaseStats
} from './memory.js';
import { seedDatabase } from './seed.js';

function runVerification() {
  console.log('=== Verifying SQLite Memory & Auto-Seeding ===');

  // 1. Force seed
  const seedResult = seedDatabase(true);
  console.log(`Seeded messages count: ${seedResult.messages.length}`);
  if (seedResult.messages.length !== 6) {
    throw new Error(`Expected 6 messages seeded, got ${seedResult.messages.length}`);
  }

  // 2. Test getDatabaseStats
  const stats = getDatabaseStats();
  console.log('Stats:', stats);
  if (stats.totalMessages !== 6 || stats.sessionsCount !== 3 || stats.datesCount !== 3) {
    throw new Error(`Unexpected database stats: ${JSON.stringify(stats)}`);
  }

  // 3. Test searchMessagesByDateRange
  console.log('\n--- Testing Date Range Search ---');
  // Range around Nov 3
  const novResults = searchMessagesByDateRange(null, '2026-11-01', '2026-11-05');
  console.log(`Found ${novResults.length} messages for Nov 1 to Nov 5`);
  if (novResults.length !== 2) {
    throw new Error(`Expected 2 messages for Nov 3, got ${novResults.length}`);
  }

  // Specific session date range
  const novSessionResults = searchMessagesByDateRange('session-nov3-versions', '2026-11-01', '2026-11-05');
  if (novSessionResults.length !== 2) {
    throw new Error(`Expected 2 messages in session-nov3-versions, got ${novSessionResults.length}`);
  }

  // 4. Test searchMessagesByKeyword
  console.log('\n--- Testing Keyword & Content Search ---');
  const postgresResults = searchMessagesByKeyword(null, 'Postgres');
  console.log(`Found ${postgresResults.length} messages for keyword "Postgres"`);
  if (postgresResults.length !== 2) {
    throw new Error(`Expected 2 messages for keyword "Postgres", got ${postgresResults.length}`);
  }

  const crmResults = searchMessagesByKeyword(null, 'CRM');
  console.log(`Found ${crmResults.length} messages for keyword "CRM"`);
  if (crmResults.length !== 2) {
    throw new Error(`Expected 2 messages for keyword "CRM", got ${crmResults.length}`);
  }

  const sonnetResults = searchMessagesByKeyword(null, 'Sonnet');
  console.log(`Found ${sonnetResults.length} messages for keyword "Sonnet"`);
  if (sonnetResults.length !== 2) {
    throw new Error(`Expected 2 messages for keyword "Sonnet", got ${sonnetResults.length}`);
  }

  // 5. Test getRecentMessages
  console.log('\n--- Testing Recent Messages ---');
  const sessionRecent = getRecentMessages('session-monday-crm', 10);
  console.log(`Found ${sessionRecent.length} recent messages in session-monday-crm`);
  if (sessionRecent.length !== 2) {
    throw new Error(`Expected 2 messages in session-monday-crm, got ${sessionRecent.length}`);
  }

  const allRecent = getRecentMessages(null, 15);
  console.log(`Found ${allRecent.length} recent messages across all sessions`);
  if (allRecent.length !== 6) {
    throw new Error(`Expected 6 total messages in recent, got ${allRecent.length}`);
  }

  // 6. Test insertMessage
  console.log('\n--- Testing insertMessage ---');
  const testMsg = insertMessage(
    'test-session',
    'user',
    'Hello memory test',
    '2026-11-12T12:00:00Z',
    'test, memory'
  );
  console.log('Inserted message:', testMsg);
  if (testMsg.date_str !== '2026-11-12') {
    throw new Error(`Expected date_str 2026-11-12, got ${testMsg.date_str}`);
  }

  // Clean up test message
  db.prepare('DELETE FROM messages WHERE session_id = ?').run('test-session');

  console.log('\n ALL MEMORY TESTS PASSED SUCCESSFULLY!');
}

runVerification();

