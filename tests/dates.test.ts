import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_NOW } from './helpers.js';
import { parseDates, formatDateInTz } from '../src/context/temporalResolver.js';

describe('Date Resolution Table', () => {
  it('resolves yesterday relative to fixed NOW', () => {
    const res = parseDates('what did I ask yesterday?', FIXED_NOW, 'UTC');
    assert.equal(res.length, 1);
    assert.equal(res[0].startDate, '2026-11-11');
  });

  it('resolves last Tuesday relative to fixed NOW', () => {
    const res = parseDates('on last Tuesday we discussed Postgres', FIXED_NOW, 'UTC');
    assert.equal(res.length, 1);
    assert.equal(res[0].startDate, '2026-11-10');
  });

  it('resolves explicit date: 3 November', () => {
    const res = parseDates('what did I ask on 3 November?', FIXED_NOW, 'UTC');
    assert.equal(res.length, 1);
    assert.equal(res[0].startDate, '2026-11-03');
  });

  it('resolves ambiguous 11/3 as DD/MM in Asia/Kolkata and MM/DD in UTC', () => {
    const kolkata = parseDates('check 11/3 report', FIXED_NOW, 'Asia/Kolkata');
    assert.equal(kolkata.length, 1);
    assert.equal(kolkata[0].startDate, '2026-03-11');
    assert.equal(kolkata[0].isAmbiguous, true);

    const utc = parseDates('check 11/3 report', FIXED_NOW, 'UTC');
    assert.equal(utc.length, 1);
    assert.equal(utc[0].startDate, '2026-11-03');
    assert.equal(utc[0].isAmbiguous, true);
  });

  it('handles midnight boundary in Asia/Kolkata correctly', () => {
    // 2026-11-12T18:29:00Z is 23:59:00 on Nov 12 in Asia/Kolkata (+5:30)
    const beforeMidnight = new Date('2026-11-12T18:29:00Z');
    assert.equal(formatDateInTz(beforeMidnight, 'UTC'), '2026-11-12');
    assert.equal(formatDateInTz(beforeMidnight, 'Asia/Kolkata'), '2026-11-12');

    // 2026-11-12T18:31:00Z is 00:01:00 on Nov 13 in Asia/Kolkata (+5:30)
    const afterMidnight = new Date('2026-11-12T18:31:00Z');
    assert.equal(formatDateInTz(afterMidnight, 'UTC'), '2026-11-12');
    assert.equal(formatDateInTz(afterMidnight, 'Asia/Kolkata'), '2026-11-13');
  });
});
