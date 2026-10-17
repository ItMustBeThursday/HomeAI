import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createStatusChecker } from './status.mjs';

const config = {
  connectors: { fast: { kind: 'ollama', model: 'm1' }, gone: { kind: 'ollama', model: 'm9' }, c: { kind: 'claude-cli', model: 'haiku' }, x: { kind: 'codex-cli', model: 'g' } },
  routes: { q: { chain: ['fast'] } },
  default: 'q',
};

function fakeSpawn(code, out) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(out);
      child.stderr.end();
      child.emit('close', code);
    });
    return child;
  };
}

const fetchOk = async (url) => ({ ok: true, json: async () => (url.endsWith('/api/tags') ? { models: [{ name: 'm1' }] } : { models: [{ name: 'm1' }] }) });

test('reports per-connector health', async () => {
  const s = createStatusChecker({ fetchImpl: fetchOk, spawnImpl: fakeSpawn(0, '2.1.299 (Claude Code)\n'), codexScript: 'codex.js', exists: () => true });
  const r = await s(config);
  assert.equal(r.connectors.fast.ok, true);
  assert.equal(r.connectors.fast.loaded, true);
  assert.equal(r.connectors.gone.ok, false);
  assert.equal(r.connectors.gone.detail, 'model not installed');
  assert.equal(r.connectors.c.ok, true);
  assert.equal(r.backends['claude-cli'].detail, '2.1.299 (Claude Code)');
  assert.equal(r.connectors.x.ok, true);
});

test('unknown connector kind does not hide healthy connector results', async () => {
  const s = createStatusChecker({ fetchImpl: fetchOk });
  const r = await s({ connectors: { local: config.connectors.fast, unknown: { kind: 'unknown' } } });
  assert.equal(r.connectors.local.ok, true);
  assert.equal(r.connectors.unknown.ok, false);
  assert.match(r.connectors.unknown.detail, /Unknown connector kind/);
});

test('unreachable Ollama, failing CLI and missing codex script', async () => {
  const s = createStatusChecker({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, spawnImpl: fakeSpawn(1, 'nope'), codexScript: 'missing.js', exists: () => false });
  const r = await s(config);
  assert.equal(r.connectors.fast.ok, false);
  assert.equal(r.connectors.fast.detail, 'Ollama unreachable');
  assert.equal(r.connectors.c.ok, false);
  assert.match(r.connectors.x.detail, /not found/);
});

test('caches until ttl unless fresh', async () => {
  let calls = 0;
  let t = 0;
  const s = createStatusChecker({ fetchImpl: async (u) => (calls++, fetchOk(u)), spawnImpl: fakeSpawn(0, 'v'), exists: () => true, codexScript: 'c', now: () => t, ttlMs: 100 });
  await s(config);
  await s(config);
  assert.equal(calls, 2);
  await s(config, { fresh: true });
  assert.equal(calls, 4);
  t = 500;
  await s(config);
  assert.equal(calls, 6);
});

test('concurrent cache misses and fresh requests share backend probes', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = createStatusChecker({ fetchImpl: async u => { calls++; await gate; return fetchOk(u); }, spawnImpl: fakeSpawn(0, 'v'), exists: () => true, codexScript: 'c' });
  const requests = Array.from({ length: 20 }, (_, i) => s(config, { fresh: i % 2 === 0 }));
  assert.equal(calls, 2);
  release();
  const results = await Promise.all(requests);
  assert.ok(results.every(r => r === results[0]));
  await s(config);
  assert.equal(calls, 2);
});

test('overlapping configurations cannot overwrite each other\'s cache', async () => {
  const other = { ...config, connectors: { local: config.connectors.fast } };
  let calls = 0;
  const s = createStatusChecker({ fetchImpl: async u => { calls++; return fetchOk(u); }, spawnImpl: fakeSpawn(0, 'v'), exists: () => true, codexScript: 'c' });
  const [a, b] = await Promise.all([s(config), s(other)]);
  assert.equal(calls, 4);
  assert.equal(await s(config), a);
  assert.equal(await s(other), b);
  assert.equal(calls, 4);
});
