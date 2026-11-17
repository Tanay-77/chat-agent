import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FIXED_NOW, resetInMemoryDb } from './helpers.js';
import { insertMessage, setFTS5AvailableForTesting, createDatabase } from '../src/db/memory.js';
import { resolveTemporalContext } from '../src/context/temporalResolver.js';

describe('Memory & Keyword Retrieval', () => {
  beforeEach(() => {
    resetInMemoryDb();
  });

  it('uses user messages only in keyword retrieval unless assistant is asked about', () => {
    insertMessage('s1', 'user', 'I booked flights to Tokyo for our vacation', '2026-11-10T10:00:00Z', null, false, 'UTC', 'u1');
    insertMessage('s1', 'assistant', 'Your flight booking to Tokyo is confirmed', '2026-11-10T10:01:00Z', null, false, 'UTC', 'u1');

    // Standard keyword query (does not ask about assistant)
    const userOnly = resolveTemporalContext('flights booking', 's2', FIXED_NOW, 4000, 'UTC', 'u1');
    assert.equal(userOnly.matchedMessages.length, 1);
    assert.equal(userOnly.matchedMessages[0].role, 'user');

    // Query asking about what assistant said
    const withAssistant = resolveTemporalContext('what did you say about flight booking?', 's2', FIXED_NOW, 4000, 'UTC', 'u1');
    const roles = withAssistant.matchedMessages.map((m) => m.role);
    assert.ok(roles.includes('assistant'));
  });

  it('never falls back to other messages when a resolved date has zero results', () => {
    insertMessage('s1', 'user', 'Discussed CRM tools on November 10', '2026-11-10T10:00:00Z', null, false, 'UTC', 'u1');

    // Query asks for 3 November (where 0 messages exist)
    const res = resolveTemporalContext('what did I ask on 3 November?', 's2', FIXED_NOW, 4000, 'UTC', 'u1');
    assert.equal(res.matchedMessages.length, 0);
    assert.ok(res.formattedContext.includes('No messages exist for 2026-11-03'));
    assert.ok(!res.formattedContext.includes('CRM tools'));
  });

  it('falls back to LIKE search when FTS5 probe is false', () => {
    insertMessage('s1', 'user', 'Deploying high performance Postgres cluster', '2026-11-10T10:00:00Z', null, false, 'UTC', 'u1');

    setFTS5AvailableForTesting(false);
    try {
      const res = resolveTemporalContext('Postgres cluster', 's2', FIXED_NOW, 4000, 'UTC', 'u1');
      assert.ok(res.matchedMessages.length >= 1);
      assert.ok(res.matchedMessages[0].content.includes('Postgres'));
    } finally {
      setFTS5AvailableForTesting(null);
    }
  });

  it('throws test guard error if default data/chat.db path is opened', () => {
    const defaultPath = path.resolve(process.cwd(), 'data', 'chat.db');
    assert.throws(
      () => createDatabase(defaultPath),
      /\[Test Guard\]/
    );
  });
});
