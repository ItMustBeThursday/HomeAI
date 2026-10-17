import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.mjs';
import { createAuth } from './access.mjs';
import { createPairing } from './pairing.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createConversationStore, createTaskHistory } from './history.mjs';

const ADMIN = 'adm-' + 'y'.repeat(30);
let server;
let base;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-'));
  const auth = createAuth({ adminToken: ADMIN, devicesFile: join(dir, 'devices.json') });
  const orchestrator = createOrchestrator({
    config: { connectors: { a: { kind: 'ollama', model: 'm' } }, routes: { quick: { chain: ['a'] } }, default: 'quick' },
    conversations: createConversationStore(join(dir, 'c')),
    history: createTaskHistory(join(dir, 't.jsonl')),
    run: async () => ({ ok: true, text: 'hi', inputTokens: 1, outputTokens: 1, costUsd: 0 }),
  });
  server = await startServer({ orchestrator, auth, pairing: createPairing({ auth }), lanAddresses: () => ['192.168.1.20'], serverName: 'TestPC', version: '9.9.9' }, { port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (path, { method = 'GET', token, body } = {}) =>
  fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

test('discover is public and minimal', async () => {
  const r = await (await call('/api/discover')).json();
  assert.deepEqual(r, { service: 'homeai-orchestrator', name: 'TestPC', version: '9.9.9', pairing: false });
});

test('pair start needs admin; claim returns a chat-only token that cannot do admin things', async () => {
  assert.equal((await call('/api/pair/start', { method: 'POST' })).status, 401);
  const s = await (await call('/api/pair/start', { method: 'POST', token: ADMIN })).json();
  assert.match(s.code, /^\d{6}$/);
  assert.deepEqual(s.addresses, ['192.168.1.20']);
  assert.match(s.url, /^homeai:\/\/pair\?host=192\.168\.1\.20&port=\d+&code=\d{6}$/);
  assert.equal((await (await call('/api/discover')).json()).pairing, true);

  const bad = await call('/api/pair/claim', { method: 'POST', body: { code: '000000', name: 'Phone' } });
  assert.equal(bad.status, 403);
  const ok = await call('/api/pair/claim', { method: 'POST', body: { code: s.code, name: 'Phone' } });
  assert.equal(ok.status, 200);
  const { token, server: info } = await ok.json();
  assert.equal(info.name, 'TestPC');

  const who = await (await call('/api/whoami', { token })).json();
  assert.deepEqual(who.scopes.sort(), ['chat', 'read']);
  assert.equal((await call('/api/devices', { token })).status, 403);
  assert.equal((await call('/api/pair/start', { method: 'POST', token })).status, 403);
  // code is single-use
  assert.equal((await call('/api/pair/claim', { method: 'POST', body: { code: s.code, name: 'Again' } })).status, 403);
  // and the new device shows up for the admin to revoke
  const list = await (await call('/api/devices', { token: ADMIN })).json();
  assert.ok(list.devices.some((d) => d.name === 'Phone'));
});

test('a proxied request cannot start pairing', async () => {
  const r = await fetch(base + '/api/pair/start', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(r.status, 403);
});
