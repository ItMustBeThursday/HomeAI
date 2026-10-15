import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEntry, summarize, checkBudget, validateCaps, capStatus } from './ledger.mjs';

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

const NOW = 1_800_000_000_000;
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
  assert.match(g.reason, /Global daily token cap/);
  assert.match(checkBudget(entries, { daily: { perConnector: { claude: { calls: 2 } } } }, 'claude', 'coding', NOW).reason, /Connector "claude" daily call cap/);
  assert.match(checkBudget(entries, { daily: { perTaskType: { coding: { tokens: 200 } } } }, 'claude', 'coding', NOW).reason, /Task type "coding" daily token cap/);
  // Caps on other connectors don't block this one.
  assert.equal(checkBudget(entries, { daily: { perConnector: { codex: { calls: 1 } } } }, 'claude', 'coding', NOW).allowed, true);
});

test('checkBudget ignores usage older than 24h', () => {
  const entries = [e({ ts: NOW - 25 * HOUR, inputTokens: 10_000 })];
  assert.equal(checkBudget(entries, { daily: { globalTokens: 100 } }, 'claude', 'coding', NOW).allowed, true);
});
