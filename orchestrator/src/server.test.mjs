import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from './server.mjs';
import { createOrchestrator } from './orchestrator.mjs';

const config = { connectors: { a: { kind: 'ollama', model: 'm' } }, routes: { quick: { chain: ['a'] } }, default: 'quick' };
let server;
let port;

before(async () => {
  const webDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(webDir, 'index.html'), '<h1>ui</h1>');
  const orchestrator = createOrchestrator({ config, run: async (e, { prompt }) => ({ ok: true, text: `echo ${prompt}`, inputTokens: 1, outputTokens: 1, costUsd: 0 }) });
  server = await startServer({ orchestrator, token: 'secret', webDir, version: '9.9.9' }, { port: 0 });
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
