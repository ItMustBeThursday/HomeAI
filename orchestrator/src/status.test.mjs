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
