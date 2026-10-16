import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { startServer } from './server.mjs';
import { createTerminals } from './terminal.mjs';

let server;
let port;
let child;
const terminals = createTerminals({
  platform: 'win32',
  baseEnv: {},
  spawnImpl: () => {
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.written = [];
    child.stdin.on('data', (d) => child.written.push(String(d)));
    child.kill = () => {};
    return child;
  },
});
const budgetWindow = { start: 1, end: 2 };

before(async () => {
  const orchestrator = { usage: () => ({ total: {}, byConnector: {}, byTaskType: {} }), capStatus: () => [], budgetWindow: () => budgetWindow, config: {}, caps: {} };
  server = await startServer({ orchestrator, terminals, network: {} }, { port: 0 });
  port = server.address().port;
});
after(() => { terminals.stop(); server.close(); });

const call = (method, path, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...(payload ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
  });
  req.on('error', reject);
  req.end(payload);
});

test('usage reports the budget block', async () => {
  const r = await call('GET', '/api/usage');
  assert.deepEqual(r.json.window, budgetWindow);
});

test('terminal API: create, stream output (with replay), send input, interrupt, close', async () => {
  const made = await call('POST', '/api/terminal', { cwd: tmpdir() });
  assert.equal(made.status, 200);
  const id = made.json.id;
  assert.equal((await call('POST', '/api/terminal', { cwd: 'relative' })).status, 400);
  assert.equal((await call('GET', '/api/terminal')).json.sessions.length, 1);

  child.stdout.write('first\r\n');
  const events = [];
  let done;
  const finished = new Promise((r) => (done = r));
  const req = request({ host: '127.0.0.1', port, path: `/api/terminal/${id}/stream?since=0`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
    assert.match(res.headers['content-type'], /event-stream/);
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const p of parts) if (p.startsWith('data: ')) events.push(JSON.parse(p.slice(6)));
      if (events.some((e) => e.text === 'first\r\n') && events.some((e) => e.text === 'second\r\n')) done();
    });
  });
  req.end();
  await new Promise((r) => setTimeout(r, 50));
  child.stdout.write('second\r\n');
  await finished; // "first" was replayed from the scrollback, "second" streamed live
  req.destroy();

  assert.equal((await call('POST', `/api/terminal/${id}/input`, { data: 'dir', run: true })).status, 200);
  assert.ok(child.written.some((w) => /^dir; Write-Output/.test(w)));
  assert.equal((await call('POST', `/api/terminal/${id}/input`, { data: 'cd C:\\Users\\x\\OneDrive' })).status, 400);
  assert.equal((await call('POST', `/api/terminal/nope/input`, { data: 'x' })).status, 404);
  assert.equal((await call('POST', `/api/terminal/${id}/interrupt`, {})).status, 200);
  assert.equal((await call('DELETE', `/api/terminal/${id}`)).status, 200);
  assert.equal((await call('GET', '/api/terminal')).json.sessions.length, 0);
});
