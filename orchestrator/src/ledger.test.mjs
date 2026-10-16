import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEntry, summarize, checkBudget, validateCaps, capStatus, budgetWindow } from './ledger.mjs';

const T0 = 1_800_000_000_000;

test('validateCaps accepts good caps and rejects typos', () => {
  const known = { connectors: ['claude'], taskTypes: ['coding'] };
  assert.ok(validateCaps({}, known));
  assert.ok(validateCaps({ daily: { globalTokens: 10, perConnector: { claude: { tokens: 5, calls: 1 } }, perTaskType: { coding: { calls: 2 } } } }, known));
  assert.throws(() => validateCaps({ weekly: {} }, known), /Unknown budget key/);
  assert.throws(() => validateCaps({ daily: { perConnector: { claud: { calls: 1 } } } }, known), /unknown "claud"/);
  assert.throws(() => validateCaps({ daily: { perConnector: { claude: { call: 1 } } } }, known), /unknown key "call"/);
  assert.throws(() => validateCaps({ daily: { perConnector: { claude: { calls: -1 } } } }, known), /non-negative/);
  assert.throws(() => validateCaps({ daily: { globalTokens: 1.5 } }, known), /globalTokens/);
});

test('capStatus lists every cap with 24h usage', () => {
  const entries = [makeEntry({ ts: T0 - 1000, connector: 'claude', taskType: 'coding', inputTokens: 100, outputTokens: 50 })];
  const rows = capStatus(entries, { daily: { globalTokens: 1000, perConnector: { claude: { calls: 3 }, other: { tokens: 9 } } } }, T0);
  assert.deepEqual(rows, [
    { scope: 'global', name: 'all', metric: 'tokens', used: 150, limit: 1000 },
    { scope: 'connector', name: 'claude', metric: 'calls', used: 1, limit: 3 },
    { scope: 'connector', name: 'other', metric: 'tokens', used: 0, limit: 9 },
  ]);
  assert.deepEqual(capStatus(entries, {}, T0), []);
});

const NOW = new Date(2027, 0, 15, 12, 0).getTime(); // local noon: inside the 08:00-13:00 block whatever the time zone
const HOUR = 3_600_000;
const e = (o) => makeEntry({ ts: NOW - HOUR, connector: 'claude', taskType: 'coding', inputTokens: 100, outputTokens: 50, ...o });

test('makeEntry applies defaults and freezes', () => {
  const entry = e({});
  assert.equal(entry.costUsd, null);
  assert.equal(entry.ok, true);
  assert.ok(Object.isFrozen(entry));
});

test('makeEntry rejects invalid fields', () => {
  assert.throws(() => makeEntry(null), /object/);
  assert.throws(() => e({ ts: 'x' }), /ts/);
  assert.throws(() => e({ connector: '' }), /connector/);
  assert.throws(() => e({ taskType: 3 }), /taskType/);
  assert.throws(() => e({ inputTokens: -1 }), /inputTokens/);
  assert.throws(() => e({ outputTokens: NaN }), /outputTokens/);
  assert.throws(() => e({ costUsd: -0.5 }), /costUsd/);
  assert.throws(() => e({ ok: 'yes' }), /ok/);
});

test('summarize totals, groups and filters by time', () => {
  const entries = [
    e({ costUsd: 0.25 }),
    e({ connector: 'fast', taskType: 'quick', inputTokens: 10, outputTokens: 5, costUsd: 0 }),
    e({ costUsd: null }),
    e({ ts: NOW - 30 * HOUR, costUsd: 9 }),
  ];
  const s = summarize(entries, NOW - 24 * HOUR);
  assert.deepEqual(s.total, { calls: 3, inputTokens: 210, outputTokens: 105, costUsd: 0.25 });
  assert.deepEqual(s.byConnector.claude, { calls: 2, inputTokens: 200, outputTokens: 100, costUsd: 0.25 });
  assert.equal(s.byTaskType.quick.calls, 1);
  assert.equal(summarize(entries).total.calls, 4);
});

test('checkBudget allows when no caps or under caps', () => {
  assert.deepEqual(checkBudget([e({})], undefined, 'claude', 'coding', NOW), { allowed: true, reason: null });
  const caps = { daily: { globalTokens: 1000, perConnector: { claude: { tokens: 1000, calls: 5 } } } };
  assert.equal(checkBudget([e({})], caps, 'claude', 'coding', NOW).allowed, true);
});

test('checkBudget names the cap reached', () => {
  const entries = [e({}), e({})]; // 300 tokens, 2 calls
  const g = checkBudget(entries, { daily: { globalTokens: 300 } }, 'claude', 'coding', NOW);
  assert.equal(g.allowed, false);
  assert.match(g.reason, /Global token cap for this block/);
  assert.match(checkBudget(entries, { daily: { perConnector: { claude: { calls: 2 } } } }, 'claude', 'coding', NOW).reason, /Connector "claude" call cap for this block/);
  assert.match(checkBudget(entries, { daily: { perTaskType: { coding: { tokens: 200 } } } }, 'claude', 'coding', NOW).reason, /Task type "coding" token cap for this block/);
  // Caps on other connectors don't block this one.
  assert.equal(checkBudget(entries, { daily: { perConnector: { codex: { calls: 1 } } } }, 'claude', 'coding', NOW).allowed, true);
});

const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime(); // local time, Oct 2026

test('budgetWindow: 5h blocks counted from 08:00, last block cut at the next reset', () => {
  const w = (ts, caps = {}) => { const r = budgetWindow(caps, ts); return [r.start, r.end]; };
  assert.deepEqual(w(at(16, 8, 0)), [at(16, 8), at(16, 13)]);
  assert.deepEqual(w(at(16, 12, 59)), [at(16, 8), at(16, 13)]);
  assert.deepEqual(w(at(16, 13, 0)), [at(16, 13), at(16, 18)]);
  assert.deepEqual(w(at(16, 23, 30)), [at(16, 23), at(17, 4)]);
  assert.deepEqual(w(at(17, 2, 0)), [at(16, 23), at(17, 4)]);
  assert.deepEqual(w(at(17, 5, 0)), [at(17, 4), at(17, 8)]); // short block ends at the 08:00 reset
  assert.deepEqual(w(at(17, 8, 0)), [at(17, 8), at(17, 13)]);
  assert.deepEqual(w(at(16, 10), { window: { hours: 4, resetAt: '06:30' } }), [at(16, 6, 30), at(16, 10, 30)]);
});

test('checkBudget only counts usage in the current block, and resets at the boundary', () => {
  const caps = { window: { hours: 5, resetAt: '08:00' }, caps: { globalTokens: 100 } };
  const entries = [e({ ts: at(16, 12, 30), inputTokens: 10_000 })]; // 08:00-13:00 block
  assert.equal(checkBudget(entries, caps, 'claude', 'coding', at(16, 12, 59)).allowed, false);
  assert.equal(checkBudget(entries, caps, 'claude', 'coding', at(16, 13, 0)).allowed, true); // new block
  // Usage from before the previous reset or earlier in the day does not count either.
  assert.equal(checkBudget([e({ ts: at(16, 9), inputTokens: 10_000 })], caps, 'claude', 'coding', at(16, 14)).allowed, true);
  assert.match(checkBudget(entries, caps, 'claude', 'coding', at(16, 12, 59)).reason, /Global token cap for this block/);
});

test('the old "daily" key is still read as caps', () => {
  const entries = [e({ ts: at(16, 9), inputTokens: 10_000 })];
  assert.equal(checkBudget(entries, { daily: { globalTokens: 100 } }, 'claude', 'coding', at(16, 10)).allowed, false);
  assert.throws(() => validateCaps({ daily: {}, caps: {} }), /not both/);
});

test('validateCaps checks the window', () => {
  assert.ok(validateCaps({ window: { hours: 5, resetAt: '08:00' } }));
  assert.throws(() => validateCaps({ window: { hours: 0 } }), /hours/);
  assert.throws(() => validateCaps({ window: { hours: 5, resetAt: '8am' } }), /HH:MM/);
  assert.throws(() => validateCaps({ window: { span: 5 } }), /Unknown window key/);
});
