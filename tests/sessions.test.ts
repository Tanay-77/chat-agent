import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetInMemoryDb } from './helpers.js';
import {
  insertMessage,
  createSession,
  getUserSessions,
  getUserSessionsWithSummary,
  getSessionMessages,
  searchMessagesFTS,
  db
} from '../src/db/memory.js';

describe('Sessions & User Isolation', () => {
  beforeEach(() => {
    resetInMemoryDb();
  });

  it('enforces strict per-user data isolation', () => {
    const userA = 'user-alice';
    const userB = 'user-bob';

    insertMessage('session-alice', 'user', 'Secret plans for Project Pegasus', '2026-11-10T10:00:00Z', null, false, 'UTC', userA);
    insertMessage('session-bob', 'user', 'Project Kraken updates', '2026-11-10T10:00:00Z', null, false, 'UTC', userB);

    // Bob cannot fetch Alice's session messages
    const bobFetchAlice = getSessionMessages('session-alice', userB);
    assert.equal(bobFetchAlice, null);

    // Alice cannot fetch Bob's session messages
    const aliceFetchBob = getSessionMessages('session-bob', userA);
    assert.equal(aliceFetchBob, null);

    // Bob cannot find Alice's messages via search
    const bobSearch = searchMessagesFTS('Pegasus', { userId: userB });
    assert.equal(bobSearch.length, 0);

    // Bob's session list does not contain Alice's session
    const bobSessions = getUserSessions(userB);
    assert.equal(bobSessions.length, 1);
    assert.equal(bobSessions[0].id, 'session-bob');
  });

  it('creates no empty history rows on New Chat', () => {
    const userId = 'user-test';
    const newSessionId = 'session-fresh';

    createSession(newSessionId, userId, 'New Conversation');

    // Verify messages table has 0 rows for the new session
    const rows = db.prepare('SELECT * FROM messages WHERE session_id = ?').all(newSessionId);
    assert.equal(rows.length, 0);

    // getUserSessionsWithSummary excludes empty sessions without messages
    const summaries = getUserSessionsWithSummary(userId);
    assert.equal(summaries.filter((s) => s.id === newSessionId).length, 0);

    // Message is only added when user actually sends one
    insertMessage(newSessionId, 'user', 'Hello world', '2026-11-12T10:00:00Z', null, false, 'UTC', userId);
    const updatedRows = db.prepare('SELECT * FROM messages WHERE session_id = ?').all(newSessionId);
    assert.equal(updatedRows.length, 1);
  });
});
