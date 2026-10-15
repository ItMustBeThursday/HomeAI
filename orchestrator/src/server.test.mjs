import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from './server.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createConversationStore, createTaskHistory } from './history.mjs';
import { createConfigWriter } from './configfiles.mjs';
import { readdirSync, readFileSync } from 'node:fs';

const config = { connectors: { a: { kind: 'ollama', model: 'm' } }, routes: { quick: { chain: ['a'] } }, default: 'quick' };
let server;
let port;
const saved = [];

before(async () => {
  const webDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(webDir, 'index.html'), '<h1>ui</h1>');
  const conversations = createConversationStore(mkdtempSync(join(tmpdir(), 'conv-')));
  const orchestrator = createOrchestrator({
    config,
    conversations,
    history: createTaskHistory(join(mkdtempSync(join(tmpdir(), 'hist-')), 't.jsonl')),
    run: async (e, { prompt }) => ({ ok: true, text: `echo ${prompt}`, inputTokens: 1, outputTokens: 1, costUsd: 0 }),
  });
  const status = async (cfg, { fresh }) => ({ fresh, connectors: Object.keys(cfg.connectors) });
  server = await startServer({ orchestrator, conversations, status, saveConfig: (kind, obj) => saved.push([kind, obj]), token: 'secret', webDir, version: '9.9.9' }, { port: 0 });
  port = server.address().port;
});
after(() => server.close());

function call(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const auth = { authorization: 'Bearer secret' };
const json = (r) => JSON.parse(r.body);

test('health is public', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(json(r), { ok: true, version: '9.9.9' });
});

test('other endpoints need the token', async () => {
  assert.equal((await call('GET', '/api/config')).status, 401);
  assert.equal((await call('GET', '/api/config', { headers: { authorization: 'Bearer wrong!' } })).status, 401);
  assert.equal(json(await call('GET', '/api/config', { headers: auth })).default, 'quick');
});

test('task runs and usage reflects it', async () => {
  const r = await call('POST', '/api/task', { headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }) });
  assert.equal(r.status, 200);
  assert.equal(json(r).text, 'echo hi');
  const u = json(await call('GET', '/api/usage?hours=1', { headers: auth }));
  assert.equal(u.total.calls, 1);
});

test('task input errors', async () => {
  const h = { ...auth, 'content-type': 'application/json' };
  assert.equal((await call('POST', '/api/task', { headers: auth, body: '{}' })).status, 415);
  assert.equal((await call('POST', '/api/task', { headers: h, body: '{bad' })).status, 400);
  assert.match(json(await call('POST', '/api/task', { headers: h, body: '{}' })).error, /prompt/);
  assert.equal((await call('GET', '/api/usage?hours=-1', { headers: auth })).status, 400);
  assert.equal((await call('GET', '/api/nope', { headers: auth })).status, 404);
});

const H = { ...auth, 'content-type': 'application/json' };

test('chat creates a conversation, continues it, and lists/renames/archives', async () => {
  const r1 = json(await call('POST', '/api/chat', { headers: H, body: JSON.stringify({ prompt: 'one' }) }));
  assert.equal(r1.reply.text, 'echo one');
  const id = r1.conversation.id;
  const r2 = json(await call('POST', '/api/chat', { headers: H, body: JSON.stringify({ conversationId: id, prompt: 'two' }) }));
  assert.match(r2.reply.text, /User: one/);
  assert.equal(json(await call('GET', `/api/conversations/${id}`, { headers: auth })).messages.length, 4);
  assert.equal(json(await call('PATCH', `/api/conversations/${id}`, { headers: H, body: '{"title":"Renamed"}' })).title, 'Renamed');
  assert.ok(json(await call('GET', '/api/conversations', { headers: auth })).conversations.some((c) => c.id === id));
  assert.equal((await call('DELETE', `/api/conversations/${id}`, { headers: auth })).status, 200);
  assert.equal((await call('GET', `/api/conversations/${id}`, { headers: auth })).status, 404);
  assert.equal((await call('GET', '/api/conversations/..%2F..%2Fx', { headers: auth })).status, 400);
  assert.equal((await call('POST', '/api/chat', { headers: H, body: '{"conversationId":"missing-id-123","prompt":"x"}' })).status, 404);
});

test('history, usage caps and status', async () => {
  const h = json(await call('GET', '/api/history?limit=5', { headers: auth }));
  assert.ok(h.tasks.length >= 1);
  assert.ok(h.tasks[0].attempts);
  assert.equal((await call('GET', '/api/history?limit=0', { headers: auth })).status, 400);
  assert.deepEqual(json(await call('GET', '/api/usage', { headers: auth })).caps, []);
  assert.deepEqual(json(await call('GET', '/api/status?fresh=1', { headers: auth })), { fresh: true, connectors: ['a'] });
});

test('config edits are validated, applied and saved', async () => {
  const bad = await call('PUT', '/api/config/routes', { headers: H, body: JSON.stringify({ ...config, default: 'nope' }) });
  assert.equal(bad.status, 400);
  assert.equal(saved.length, 0);
  const next = { ...config, routes: { ...config.routes, extra: { chain: ['a'] } } };
  assert.equal((await call('PUT', '/api/config/routes', { headers: H, body: JSON.stringify(next) })).status, 200);
  assert.ok(json(await call('GET', '/api/config', { headers: auth })).routes.extra);
  assert.equal((await call('PUT', '/api/config/budgets', { headers: H, body: '{"daily":{"perConnector":{"zz":{"calls":1}}}}' })).status, 400);
  assert.equal((await call('PUT', '/api/config/budgets', { headers: H, body: '{"daily":{"perConnector":{"a":{"calls":100}}}}' })).status, 200);
  assert.deepEqual(saved.map((s) => s[0]), ['routes', 'budgets']);
  assert.equal(json(await call('GET', '/api/usage', { headers: auth })).caps[0].limit, 100);
});

test('config writer keeps a backup of the previous file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const file = join(dir, 'routes.json');
  let t = 0;
  const save = createConfigWriter(join(dir, 'bak'), { keep: 2, now: () => (t += 1000) });
  save(file, { v: 1 });
  save(file, { v: 2 });
  save(file, { v: 3 });
  save(file, { v: 4 });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).v, 4);
  const baks = readdirSync(join(dir, 'bak')).sort();
  assert.equal(baks.length, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, 'bak', baks[1]), 'utf8')).v, 3);
});

test('foreign Host header is refused', async () => {
  assert.equal((await call('GET', '/api/health', { headers: { host: 'evil.example:80' } })).status, 421);
});

test('serves static web files without traversal', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/html/);
  assert.equal((await call('GET', '/../package.json')).status, 404);
  assert.equal((await call('GET', '/%2e%2e/%2e%2e/package.json')).status, 404);
  assert.equal((await call('GET', '/missing.js')).status, 404);
});
