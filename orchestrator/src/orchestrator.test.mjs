import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from './orchestrator.mjs';
import { createLedgerStore } from './store.mjs';

const config = {
  connectors: { a: { kind: 'ollama', model: 'm-a' }, b: { kind: 'claude-cli', model: 'm-b' } },
  routes: { quick: { chain: ['a', 'b'] }, solo: { chain: ['b'] } },
  default: 'quick',
};
const ok = (text) => ({ ok: true, text, inputTokens: 10, outputTokens: 5, costUsd: 0 });

test('returns first successful connector and records usage', async () => {
  const calls = [];
  const o = createOrchestrator({ config, run: async (e, p) => (calls.push([e.connector, p]), ok('hi')) });
  const r = await o.task({ taskType: 'quick', prompt: 'p', system: 's' });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'hi');
  assert.equal(r.connector, 'a');
  assert.deepEqual(calls, [['a', { prompt: 'p', system: 's' }]]);
  assert.equal(o.usage(0).total.calls, 1);
});

test('falls back on failure or thrown error, recording each attempt', async () => {
  const o = createOrchestrator({ config, run: async (e) => { if (e.connector === 'a') throw new Error('down'); return ok('from b'); } });
  const r = await o.task({ prompt: 'p' });
  assert.equal(r.connector, 'b');
  assert.equal(r.attempts[0].error, 'down');
  assert.equal(o.usage(0).total.calls, 2);
  assert.equal(o.usage(0).byConnector.a.calls, 1);
});

test('unknown task type uses default route', async () => {
  const o = createOrchestrator({ config, run: async () => ok('x') });
  assert.equal((await o.task({ taskType: 'nope', prompt: 'p' })).taskType, 'quick');
});

test('skips connectors over budget and reports total failure', async () => {
  let t = 1000;
  const caps = { daily: { perConnector: { b: { calls: 1 } } } };
  const o = createOrchestrator({ config, caps, now: () => t++, run: async (e) => (e.connector === 'b' ? ok('b') : { ok: false, error: 'bad', inputTokens: 0, outputTokens: 0 }) });
  assert.equal((await o.task({ taskType: 'solo', prompt: 'p' })).ok, true);
  const r = await o.task({ taskType: 'solo', prompt: 'p' });
  assert.equal(r.ok, false);
  assert.match(r.attempts[0].skipped, /Connector "b" daily call cap/);
});

test('rejects bad input', async () => {
  const o = createOrchestrator({ config, run: async () => ok('x') });
  await assert.rejects(o.task({ prompt: '  ' }), /prompt/);
  await assert.rejects(o.task({ prompt: 'p', system: 3 }), /system/);
  assert.throws(() => createOrchestrator({ config, run: null }), /run/);
});

test('ledger persists across restarts and skips corrupt lines', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'orch-')), 'sub', 'ledger.jsonl');
  const store = createLedgerStore(file);
  const o = createOrchestrator({ config, store, run: async () => ok('x') });
  await o.task({ prompt: 'p' });
  appendFileSync(file, '{"broken\n');
  const again = createOrchestrator({ config, store: createLedgerStore(file), run: async () => ok('x') });
  assert.equal(again.usage(0).total.calls, 1);
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('missing ledger file loads empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-'));
  writeFileSync(join(dir, 'x'), '');
  assert.deepEqual(createLedgerStore(join(dir, 'none.jsonl')).load(), []);
});
