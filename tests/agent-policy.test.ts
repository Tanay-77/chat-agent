import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_NOW, resetInMemoryDb, mockGemini } from './helpers.js';
import { insertMessage } from '../src/db/memory.js';
import { runAgent, classifyIntent } from '../src/agent/runner.js';

describe('Agent Policy & Grounding', () => {
  beforeEach(() => {
    resetInMemoryDb();
  });

  it('gives a no-record answer on empty DB for "what did I ask on 3 November?"', async () => {
    const mock = mockGemini(async ({ systemInstruction }) => {
      assert.ok(systemInstruction?.includes('No messages exist for 2026-11-03'));
      return { text: 'You did not ask any questions on 3 November.' };
    });

    const answer = await runAgent('what did I ask on 3 November?', 's1', () => {}, FIXED_NOW, {
      userId: 'u1',
      mockGeminiCall: mock
    });

    assert.match(answer.toLowerCase(), /no record|no messages|not ask|no prior/);
  });

  it('enforces search policy: recall makes 0 searches, verify makes exactly 1, hard cap 2', async () => {
    // 1. Recall intent -> 0 searches
    const recallIntent = classifyIntent('what did I tell you yesterday?');
    assert.equal(recallIntent.intent, 'RECALL');
    assert.equal(recallIntent.firstTurnMode, 'NONE');

    let searchCalls = 0;
    await runAgent('what did I tell you yesterday?', 's-recall', (ev) => {
      if (ev.type === 'tool_start') searchCalls++;
    }, FIXED_NOW, {
      userId: 'u1',
      mockGeminiCall: mockGemini({ text: 'You told me about your trip.' })
    });
    assert.equal(searchCalls, 0);

    // 2. Verify intent -> exactly 1 search
    const verifyIntent = classifyIntent('is that still the price of HubSpot?');
    assert.equal(verifyIntent.intent, 'VERIFY');
    assert.equal(verifyIntent.firstTurnMode, 'ANY');

    let verifySearches = 0;
    const mockSearchResults = [{
      query: 'HubSpot pricing',
      title: 'HubSpot Pricing',
      url: 'https://hubspot.com/pricing',
      snippet: 'HubSpot pricing is $90/month.'
    }];

    await runAgent('is that still the price of HubSpot?', 's-verify', (ev) => {
      if (ev.type === 'tool_start') verifySearches++;
    }, FIXED_NOW, {
      userId: 'u1',
      mockSearchResults,
      mockGeminiCall: mockGemini(async ({ mode }) => {
        if (mode === 'ANY') {
          return { functionCalls: [{ name: 'web_search', args: { queries: ['HubSpot pricing'] } }] };
        }
        return { text: 'The verified price is $90/month.' };
      })
    });
    assert.equal(verifySearches, 1);

    // 3. Hard cap 2: retry on 0 results executes at most 1 retry (total 2)
    let retrySearches = 0;
    await runAgent('has Node.js pricing changed?', 's-retry', (ev) => {
      if (ev.type === 'tool_start') retrySearches++;
    }, FIXED_NOW, {
      userId: 'u1',
      mockSearchResults: [], // Empty results triggers retry
      mockGeminiCall: mockGemini(async ({ label }) => {
        return { functionCalls: [{ name: 'web_search', args: { queries: ['Node.js pricing'] } }] };
      })
    });
    assert.equal(retrySearches, 2);
  });

  it('grounding: planted wrong memory + mocked search result gives search result answer', async () => {
    insertMessage('s-old', 'assistant', 'The latest version of Node.js is 22.11.0.', '2026-11-09T10:00:00Z', null, false, 'UTC', 'u1');

    const mockSearchResults = [{
      query: 'latest stable Node.js',
      title: 'Node.js v26.13.0 Released',
      url: 'https://nodejs.org/en/blog/release/v26.13.0',
      snippet: 'Node.js v26.13.0 is the current latest stable release.'
    }];

    const mock = mockGemini(async ({ mode }) => {
      if (mode === 'ANY') {
        return { functionCalls: [{ name: 'web_search', args: { queries: ['latest stable Node.js'] } }] };
      }
      return { text: 'The current latest version is Node.js 26.13.0 ([nodejs.org](https://nodejs.org/en/blog/release/v26.13.0)).' };
    });

    const answer = await runAgent('what is the latest stable Node.js?', 's-ground', () => {}, FIXED_NOW, {
      userId: 'u1',
      mockSearchResults,
      mockGeminiCall: mock
    });

    assert.ok(answer.includes('26.13.0'), 'Answer must contain 26.13.0 from search result');
    assert.ok(!answer.includes('22.11.0'), 'Answer must not contain 22.11.0 from planted memory');
  });
});
