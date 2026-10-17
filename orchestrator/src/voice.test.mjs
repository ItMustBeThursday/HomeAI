import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createConversationStore, createTaskHistory } from './history.mjs';
import { createVoice } from './voice.mjs';

const config = { connectors: { a: { kind: 'ollama', model: 'm' } }, routes: { quick: { chain: ['a'] } }, default: 'quick' };
let server, base, fake, fakeUrl;
const seen = [];

before(async () => {
  // Stand-in for the Python voice service.
  const { createServer } = await import('node:http');
  fake = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, body: body.toString('latin1') });
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true }));
    if (req.url.startsWith('/stt')) return res.end(JSON.stringify({ ok: true, text: 'hello there' }));
    if (req.url === '/tts') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(Buffer.from('RIFFfake')); }
    if (req.url === '/clone/bad') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ detail: 'Sample is 1.0s' })); }
    res.end(JSON.stringify({ ok: true, name: 'x' }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  const webDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(webDir, 'index.html'), 'ui');
  const conversations = createConversationStore(mkdtempSync(join(tmpdir(), 'conv-')));
  const orchestrator = createOrchestrator({ config, conversations, history: createTaskHistory(join(mkdtempSync(join(tmpdir(), 'h-')), 't.jsonl')), run: async () => ({ ok: true, text: 'x', inputTokens: 1, outputTokens: 1, costUsd: 0 }) });
  server = await startServer({ orchestrator, conversations, token: 'secret', webDir, voice: createVoice({ url: fakeUrl }) }, { port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fake.close(); });

const auth = { authorization: 'Bearer secret' };

test('voice routes require a token', async () => {
  assert.equal((await fetch(`${base}/api/voice/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/voice/stt`, { method: 'POST', body: 'x' })).status, 401);
});

test('status reports availability', async () => {
  const r = await (await fetch(`${base}/api/voice/status`, { headers: auth })).json();
  assert.equal(r.available, true);
});

test('stt forwards raw audio and returns text', async () => {
  const r = await fetch(`${base}/api/voice/stt`, { method: 'POST', headers: auth, body: Buffer.from([1, 2, 3, 250]) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).text, 'hello there');
  assert.equal(seen.at(-1).body.length, 4);
});

test('tts returns audio bytes', async () => {
  const r = await fetch(`${base}/api/voice/tts`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', voice: 'clone:adam' }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'RIFFfake');
  assert.equal(JSON.parse(seen.at(-1).body).voice, 'clone:adam');
});

test('service errors keep their meaning', async () => {
  const r = await fetch(`${base}/api/voice/clone/bad`, { method: 'POST', headers: auth, body: Buffer.alloc(10) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Sample is/);
});

test('offline voice service gives 503 / available:false', async () => {
  const dead = createVoice({ url: 'http://127.0.0.1:1' });
  await assert.rejects(dead.stt(Buffer.alloc(1)), (e) => e.status === 503);
});
