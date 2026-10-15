import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { EventEmitter } from 'node:events';
import { createOrchestrator } from './orchestrator.mjs';
import { createLimiter } from './limiter.mjs';
import { createLedgerStore } from './store.mjs';
import { createTaskHistory } from './history.mjs';
import { createScheduler } from './scheduler.mjs';
import { startServer } from './server.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'wire-'));
const config = { connectors: { a: { kind: 'ollama', model: 'm' }, b: { kind: 'codex-cli', model: 'x' } }, routes: { quick: { chain: ['a'] }, code: { chain: ['b'] } }, default: 'quick' };

test('orchestrator queues ollama calls one at a time but not other kinds', async () => {
  let active = 0;
  let peak = 0;
  const run = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
    return { ok: true, text: 'x', inputTokens: 1, outputTokens: 1 };
  };
  const o = createOrchestrator({ config, run, limiter: createLimiter({ limits: { ollama: 1, 'codex-cli': 2 } }) });
  await Promise.all([1, 2, 3].map(() => o.task({ taskType: 'quick', prompt: 'p' })));
  assert.equal(peak, 1);
  peak = 0;
  await Promise.all([1, 2].map(() => o.task({ taskType: 'code', prompt: 'p' })));
  assert.equal(peak, 2);
  assert.deepEqual(Object.keys(o.queue()).sort(), ['codex-cli', 'ollama']);
});

test('ledger store rolls over when large and still reloads rotated entries', () => {
  const d = tmp();
  const f = join(d, 'ledger.jsonl');
  const now = Date.now();
  const store = createLedgerStore(f, { maxBytes: 200, now: () => now });
  const e = (i) => ({ ts: now + i, connector: 'a', taskType: 'quick', inputTokens: 1, outputTokens: 1, costUsd: null, ok: true });
  for (let i = 0; i < 6; i += 1) store.append(e(i));
  const rotated = readdirSync(d).filter((n) => n !== 'ledger.jsonl');
  assert.ok(rotated.length >= 1, 'a rotated file exists');
  assert.equal(createLedgerStore(f, { maxBytes: 200, now: () => now }).load().length, 6);
});

test('task history rolls over without losing the in-memory view', () => {
  const d = tmp();
  const h = createTaskHistory(join(d, 'tasks.jsonl'), { maxBytes: 150 });
  for (let i = 0; i < 5; i += 1) h.append({ id: String(i), prompt: 'x'.repeat(60), ok: true });
  assert.ok(readdirSync(d).length >= 2);
  assert.equal(h.list(10).length, 5);
});

function call(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('schedule endpoints list jobs and run one on demand', async () => {
  const web = tmp();
  writeFileSync(join(web, 'index.html'), 'ui');
  const orchestrator = createOrchestrator({ config, run: async () => ({ ok: true, text: 'x', inputTokens: 0, outputTokens: 0 }), limiter: createLimiter() });
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push([cmd, ...args]);
    const c = new EventEmitter();
    c.stdout = Object.assign(new EventEmitter(), { setEncoding() { return this; } });
    c.stderr = Object.assign(new EventEmitter(), { setEncoding() { return this; } });
    c.stdin = Object.assign(new EventEmitter(), { end() {} });
    c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', 'backed up'); c.emit('close', 0); });
    return c;
  };
  const scheduler = createScheduler({ config: { enabled: false, jobs: [{ name: 'nightly-backup', dailyAt: '03:00', command: ['bk', '1'] }] }, spawnImpl });
  const server = await startServer({ orchestrator, scheduler, webDir: web }, { port: 0 });
  const port = server.address().port;
  try {
    const list = await call(port, 'GET', '/api/schedule');
    assert.equal(list.status, 200);
    assert.equal(list.json.enabled, false);
    assert.equal(list.json.jobs[0].name, 'nightly-backup');
    const ran = await call(port, 'POST', '/api/schedule/run', { name: 'nightly-backup' });
    assert.equal(ran.status, 200);
    assert.equal(ran.json.ok, true);
    assert.deepEqual(calls, [['bk', '1']]);
    assert.equal((await call(port, 'POST', '/api/schedule/run', { name: 'nope' })).status, 400);
  } finally {
    server.close();
  }
});
