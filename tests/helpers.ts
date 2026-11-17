process.env.NODE_ENV = 'test';
process.env.TEST_DB_PATH = ':memory:';

import { createDatabase, setDatabase } from '../src/db/memory.js';
import type { MockGeminiHandler } from '../src/agent/runner.js';

export const FIXED_NOW = new Date('2026-11-12T12:00:00Z');

export function resetInMemoryDb() {
  const db = createDatabase(':memory:');
  setDatabase(db);
  return db;
}

export function mockGemini(
  response: string | { text?: string; functionCalls?: any[] } | ((params: any) => Promise<any> | any)
): MockGeminiHandler {
  return async (params) => {
    if (typeof response === 'function') {
      return response(params);
    }
    if (typeof response === 'string') {
      return { text: response };
    }
    return response;
  };
}
