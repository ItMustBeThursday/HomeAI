import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from './server.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createConversationStore, createTaskHistory } from './history.mjs';
import { createPrivateSessions } from './private.mjs';

const config = {
  connectors: { loc: { kind: 'ollama', model: 'm' }, cloud: { kind: 'claude-cli', model: 'c' }, img: { kind: 'comfyui', media: 'image', model: 'i', workflow: 'x.json' } },
  routes: { quick: { chain: ['loc', 'cloud'], memory: true }, cloudonly: { chain: ['cloud'] }, agent: { chain: ['cloud'], agent: true, tools: ['Bash'] }, image: { chain: ['img'] } },
  default: 'quick',
};
let server, port, sessions, root, convDir, hist, ledgerAppends, memoryCalls, runs, orchestrator;

before(async () => {
  root = join(mkdtempSync(join(tmpdir(), 'priv-')), 'private');
  mkdirSync(join(root, 'leftover'), { recursive: true });
  writeFileSync(join(root, 'leftover', 'old.txt'), 'from a crash');
  sessions = createPrivateSessions({ root, sweepMs: 20 });
  convDir = mkdtempSync(join(tmpdir(), 'conv-'));
  const conversations = createConversationStore(convDir);
  hist = createTaskHistory(join(mkdtempSync(join(tmpdir(), 'hist-')), 't.jsonl'));
  ledgerAppends = 0; memoryCalls = 0; runs = [];
  orchestrator = createOrchestrator({
    config, conversations, history: hist,
    store: { load: () => [], append: () => { ledgerAppends++; }, loadReset: () => -1 },
    memory: { contextAsync: async () => { memoryCalls++; return 'MEM'; } },
    run: async (e, o) => {
      runs.push({ connector: e.connector, ...o });
      if (e.kind === 'comfyui') { writeFileSync(join(o.privateDir, 'abcd-pic.png'), 'png'); return { ok: true, text: 'Saved abcd-pic.png', files: [{ name: 'abcd-pic.png', kind: 'png' }], settings: {} }; }
      return { ok: true, text: `echo:${o.prompt.length}`, inputTokens: 1, outputTokens: 1, costUsd: 0 };
    },
  });
  server = await startServer({ orchestrator, conversations, privateSessions: sessions, token: 'secret' }, { port: 0 });
  port = server.address().port;
});
after(() => { server.close(); sessions.closeAll(); });

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, authorization: 'Bearer secret', 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('start-up wipes leftovers from a crashed run', () => {
  assert.equal(existsSync(join(root, 'leftover')), false);
});

test('private chat keeps context in memory only and records nothing anywhere', async () => {
  const { id } = (await call('POST', '/api/private')).json();
  const a = await call('POST', `/api/private/${id}/chat`, { prompt: 'my secret one', taskType: 'quick' });
  assert.equal(a.status, 200);
  await call('POST', `/api/private/${id}/chat`, { prompt: 'second', taskType: 'quick' });
  assert.match(runs.at(-1).prompt, /my secret one/, 'earlier turns reach the model');
  assert.equal(runs.every((r) => r.connector === 'loc'), true);
  assert.equal(runs.every((r) => !!r.privateDir), true);
  assert.equal(readdirSync(convDir, { recursive: true }).filter((f) => f.endsWith('.json')).length, 0, 'no conversation files');
  assert.equal(hist.list().length, 0, 'no task history');
  assert.equal(ledgerAppends, 0, 'no ledger entries');
  assert.equal(memoryCalls, 0, 'memory not read or written');
  assert.equal(orchestrator.usage(0).total.calls, 0);
  assert.equal((await call('GET', '/api/conversations')).json().conversations?.length ?? 0, 0);
  await call('DELETE', `/api/private/${id}`);
});

test('cloud models are never used: failure of the local model does not fall back', async () => {
  const { id } = (await call('POST', '/api/private')).json();
  runs.length = 0;
  const pinned = await call('POST', `/api/private/${id}/chat`, { prompt: 'x', taskType: 'quick', connector: 'cloud' });
  assert.equal(pinned.status, 400);
  assert.match(pinned.json().error, /local/);
  const only = await call('POST', `/api/private/${id}/chat`, { prompt: 'x', taskType: 'cloudonly' });
  assert.equal(only.status, 400);
  assert.match(only.json().error, /no local model/);
  const agent = await call('POST', `/api/private/${id}/chat`, { prompt: 'x', taskType: 'agent' });
  assert.equal(agent.status, 400);
  assert.equal(runs.length, 0);
  await call('DELETE', `/api/private/${id}`);
});

test('generated files are served from the session and removed when it closes', async () => {
  const { id } = (await call('POST', '/api/private')).json();
  const r = await call('POST', `/api/private/${id}/chat`, { prompt: 'draw a picture of a cat', taskType: 'quick' });
  assert.equal(r.status, 200);
  const dir = join(root, id);
  assert.equal(existsSync(join(dir, 'media', 'abcd-pic.png')), true);
  const got = await call('GET', `/api/private/${id}/media/abcd-pic.png`);
  assert.equal(got.status, 200);
  const closed = await call('POST', `/api/private/${id}/close`);
  assert.equal(closed.json().closed, true);
  assert.equal(existsSync(dir), false, 'session folder removed');
  assert.equal((await call('GET', `/api/private/${id}/media/abcd-pic.png`)).status, 404);
  assert.equal((await call('POST', `/api/private/${id}/chat`, { prompt: 'hi' })).status, 404);
});

test('idle sessions expire and their files are removed', async () => {
  let t = 1000;
  const s2 = createPrivateSessions({ root: join(mkdtempSync(join(tmpdir(), 'p2-')), 'private'), ttlMs: 100, sweepMs: 10, now: () => t });
  const s = s2.create();
  writeFileSync(join(s.mediaDir, 'f.png'), 'x');
  t += 500;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s2.count(), 0);
  assert.equal(existsSync(s.dir), false);
});

test('root must be named private (guards the recursive delete)', () => {
  assert.throws(() => createPrivateSessions({ root: join(tmpdir(), 'data') }), /private/);
});
