import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer, hostAllowed, isRemote } from './server.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { createConversationStore, createTaskHistory } from './history.mjs';
import { createAuth } from './access.mjs';
import { createAttachmentStore } from './attachments.mjs';
import { createMemoryStore } from './memory.mjs';
import { createShell } from './shell.mjs';
import { PNG } from './attachments.test.mjs';
import { createVault } from './vault.mjs';
import { createConnections } from './connections.mjs';

const config = {
  connectors: { a: { kind: 'ollama', model: 'm', vision: true }, c: { kind: 'claude-cli', model: 'sonnet' } },
  routes: {
    quick: { chain: ['a'] },
    vision: { chain: ['a'] },
    agent: { chain: ['c'], agent: true, tools: ['Bash'] },
    plan: { chain: ['c'], agent: true, readOnly: true, then: 'agent', tools: ['Read'] },
  },
  auto: { chat: 'quick', act: 'agent', plan: 'plan', check: 'a' },
  default: 'quick',
};
const ADMIN = 'adm-' + 'x'.repeat(30);
let server;
let port;
let chatToken;
let readToken;
let projectDir;
const runs = [];
let slow = null; // resolved by a test to let a hung run finish
const githubCalls = [];

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'srv-'));
  projectDir = mkdtempSync(join(tmpdir(), 'proj-'));
  const webDir = join(dir, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<h1>ui</h1>');
  writeFileSync(join(dir, 'token.txt'), ADMIN + '\n');
  const conversations = createConversationStore(join(dir, 'conv'));
  const auth = createAuth({ adminToken: ADMIN, devicesFile: join(dir, 'devices.json') });
  chatToken = auth.addDevice({ name: 'phone', scopes: ['chat'] }).token;
  readToken = auth.addDevice({ name: 'display', scopes: ['read'] }).token;
  const orchestrator = createOrchestrator({
    config,
    conversations,
    history: createTaskHistory(join(dir, 't.jsonl')),
    run: async (entry, { prompt, images, cwd, signal, onEvent }) => {
      // The auto-route check: questions about capitals are CHAT, everything else ACT.
      if (prompt.startsWith('Classify the LAST user message')) return { ok: true, text: /capital/.test(prompt.split('LAST user message:')[1]) ? 'CHAT' : 'ACT', inputTokens: 5, outputTokens: 1 };
      runs.push({ entry, prompt, images, cwd });
      onEvent?.({ type: 'delta', text: 'he' });
      onEvent?.({ type: 'delta', text: 'llo' });
      if (prompt === 'hang') {
        await new Promise((resolve) => {
          slow = resolve;
          signal.addEventListener('abort', () => {
            runs.at(-1).aborted = true;
            resolve();
          });
        });
        throw Object.assign(new Error('Cancelled'), { cancelled: true });
      }
      return { ok: true, text: 'hello', inputTokens: 1, outputTokens: 1, costUsd: 0 };
    },
  });
  const shell = createShell({
    config: { default: 'p', projects: { p: { path: projectDir, test: [process.execPath, '-e', 'console.log("# pass 2\\n# fail 0")'] } } },
  });
  const github = {
    summary: async () => ({ repo: 'o/r', commits: [] }),
    issues: async (s) => (githubCalls.push(['issues', s]), []),
    runs: async () => [],
    createIssue: async (i) => (githubCalls.push(['create', i]), { number: 1, title: i.title }),
    comment: async () => ({ id: 1 }),
  };
  const connections = createConnections({
    vault: await createVault({ file: join(dir, 'vault.json'), codec: { protect: async (s) => s, unprotect: async (s) => s } }),
    fetchImpl: async (url, init) => ({ ok: init.headers.authorization === 'Bearer good', status: init.headers.authorization === 'Bearer good' ? 200 : 401, json: async () => ({ login: 'adam' }) }),
  });
  server = await startServer({
    orchestrator, conversations, auth, connections, attachments: createAttachmentStore(join(dir, 'att')), memory: createMemoryStore(join(dir, 'mem')), shell, github,
    network: {}, tokenFile: join(dir, 'token.txt'), webDir, version: '1.2.3',
  }, { port: 0 });
  port = server.address().port;
});
after(() => server.close());

function call(method, path, { body, token = ADMIN, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) h['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, type: res.headers['content-type'], buf, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// Reads a server-sent-event response to the end.
function sse(path, body, { token = ADMIN, abortAfterFirstEvent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      const events = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) if (p.startsWith('data: ')) events.push(JSON.parse(p.slice(6)));
        if (abortAfterFirstEvent && events.length >= 2) req.destroy();
      });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], events }));
      res.on('close', () => resolve({ status: res.statusCode, type: res.headers['content-type'], events }));
      res.on('error', () => {});
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? undefined : reject(e)));
    req.end(JSON.stringify(body));
  });
}

test('scopes: no token 401; read device cannot chat; chat device cannot edit config; admin can', async () => {
  assert.equal((await call('GET', '/api/config', { token: null })).status, 401);
  assert.equal((await call('GET', '/api/config', { token: readToken })).status, 200);
  assert.equal((await call('POST', '/api/task', { token: readToken, body: { prompt: 'x' } })).status, 403);
  assert.equal((await call('POST', '/api/task', { token: chatToken, body: { prompt: 'x' } })).status, 200);
  const put = await call('PUT', '/api/config/budgets', { token: chatToken, body: {} });
  assert.equal(put.status, 403);
  assert.match(put.json.error, /admin/);
  const who = await call('GET', '/api/whoami', { token: chatToken });
  assert.deepEqual(who.json.scopes.sort(), ['chat', 'read']);
  assert.equal((await call('GET', '/api/whoami')).json.id, 'admin');
});

test('unknown paths are 404 and wrong methods 405', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('GET', '/api/task')).status, 405);
});

test('streaming chat sends start, attempt, deltas and a done event with the saved conversation', async () => {
  const r = await sse('/api/chat', { prompt: 'hi', stream: true }, { token: chatToken });
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/event-stream/);
  assert.deepEqual(r.events.map((e) => e.type), ['start', 'conversation', 'attempt', 'delta', 'delta', 'done']);
  const done = r.events.at(-1);
  assert.equal(done.reply.text, 'hello');
  assert.ok(done.conversation.id);
  const conv = await call('GET', `/api/conversations/${done.conversation.id}`, { token: chatToken });
  assert.equal(conv.json.messages.length, 2);
});

test('streaming errors that happen after the stream opened arrive as an error event; bad input is a plain 400', async () => {
  const bad = await call('POST', '/api/chat', { token: chatToken, body: { prompt: '  ', stream: true } });
  assert.equal(bad.status, 200); // stream already opened; prompt check happens inside the orchestrator
  const r = await sse('/api/chat', { prompt: '', stream: true }, { token: chatToken });
  assert.equal(r.events.at(-1).type, 'error');
  const badImage = await call('POST', '/api/task', { token: chatToken, body: { prompt: 'x', images: [{ mediaType: 'image/png', data: 'bm90IGEgcG5n' }] } });
  assert.equal(badImage.status, 400);
});

test('a dropped connection does not cancel a chat/task run; only POST /api/runs/:id/cancel does', async () => {
  const before = runs.length;
  const runId = 'run-detach-0001';
  await sse('/api/task', { prompt: 'hang', stream: true, runId }, { token: chatToken, abortAfterFirstEvent: true });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(runs.length, before + 1);
  assert.equal(runs.at(-1).aborted, undefined, 'the run must keep going after the client drops');
  const cancel = await call('POST', `/api/runs/${runId}/cancel`, { token: chatToken, body: {} });
  assert.equal(cancel.status, 200);
  for (let i = 0; i < 50 && !runs.at(-1)?.aborted; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs.at(-1).aborted, true);
  const again = await call('POST', `/api/runs/${runId}/cancel`, { token: chatToken, body: {} });
  assert.equal(again.status, 404, 'a finished run cannot be cancelled again');
});

test('chat streams announce the conversation id early so a client that drops can find the reply', async () => {
  const s = await sse('/api/chat', { prompt: 'hi there', stream: true, runId: 'run-conv-0001' }, { token: chatToken });
  const ev = s.events.find((e) => e.type === 'conversation');
  assert.ok(ev && typeof ev.id === 'string');
  assert.ok(s.events.findIndex((e) => e.type === 'conversation') < s.events.findIndex((e) => e.type === 'done'));
});

test('a run id that is already running is refused with 409', async () => {
  const runId = 'run-dupe-0001';
  const first = sse('/api/task', { prompt: 'hang', stream: true, runId }, { token: chatToken });
  await new Promise((r) => setTimeout(r, 100));
  const second = await call('POST', '/api/task', { token: chatToken, body: { prompt: 'x', stream: true, runId } });
  assert.equal(second.status, 409);
  await call('POST', `/api/runs/${runId}/cancel`, { token: chatToken, body: {} });
  await first;
});

test('images: stored, routed to the vision route, readable back, and visible only with read scope', async () => {
  const r = await call('POST', '/api/task', { token: chatToken, body: { prompt: 'what is this', images: [{ name: 'dot.png', mediaType: 'image/png', data: PNG }] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.taskType, 'vision');
  const last = runs.at(-1);
  assert.equal(last.images.length, 1);
  const id = last.images[0].id;
  const img = await call('GET', `/api/attachments/${id}`, { token: readToken });
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/png');
  assert.deepEqual(img.buf, Buffer.from(PNG, 'base64'));
  assert.equal((await call('GET', '/api/attachments/..%2Fsecret.png', { token: readToken })).status, 400);
  assert.equal((await call('GET', `/api/attachments/${id}`, { token: null })).status, 401);
});

test('agent routes are admin-only, run in the project folder, and never accept an outside cwd', async () => {
  const denied = await call('POST', '/api/task', { token: chatToken, body: { prompt: 'x', taskType: 'agent' } });
  assert.equal(denied.status, 403);
  const ok = await call('POST', '/api/task', { body: { prompt: 'run tests', taskType: 'agent' } });
  assert.equal(ok.status, 200);
  assert.equal(runs.at(-1).cwd, projectDir);
  const escape = await call('POST', '/api/task', { body: { prompt: 'x', taskType: 'agent', cwd: '..' } });
  assert.equal(escape.status, 400);
  assert.match(escape.json.error, /inside the project/);
  const chat = await call('POST', '/api/chat', { body: { prompt: 'fix it', taskType: 'agent', project: 'p' } });
  assert.equal(chat.json.conversation.project, 'p');
  // The conversation remembers it's an agent chat: a chat-scope device can't continue it.
  const cont = await call('POST', '/api/chat', { token: chatToken, body: { conversationId: chat.json.conversation.id, prompt: 'more' } });
  assert.equal(cont.status, 403);
});

test('plan then approve: approval is admin-only, runs the then route in the planned project, and needs a pending plan', async () => {
  const plan = await call('POST', '/api/chat', { body: { prompt: 'tidy up', taskType: 'plan', project: 'p' } });
  assert.equal(plan.status, 200);
  assert.equal(runs.at(-1).entry.readOnly, true);
  assert.equal(runs.at(-1).cwd, projectDir);
  const id = plan.json.conversation.id;
  assert.equal((await call('POST', '/api/chat', { token: chatToken, body: { conversationId: id, approve: true } })).status, 403);
  assert.equal((await call('POST', '/api/chat', { body: { conversationId: id, approve: true, images: [{ name: 'a.png', mediaType: 'image/png', data: PNG }] } })).status, 400);
  const run = await call('POST', '/api/chat', { body: { conversationId: id, approve: true } });
  assert.equal(run.status, 200);
  assert.equal(run.json.reply.taskType, 'agent');
  assert.equal(runs.at(-1).entry.readOnly, undefined);
  assert.equal(runs.at(-1).cwd, projectDir);
  assert.match(runs.at(-1).prompt, /Approved plan:\nhello/);
  const again = await call('POST', '/api/chat', { body: { conversationId: id, approve: true } });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /no plan waiting/);
});

test('auto chats check every message: answer, do, plan, and "yes" approves a pending plan', async () => {
  const q = await call('POST', '/api/chat', { body: { prompt: 'what is the capital of France?', taskType: 'auto' } });
  assert.equal(q.status, 200);
  assert.equal(q.json.reply.taskType, 'quick');
  assert.equal(q.json.reply.auto.via, 'model');
  const id = q.json.conversation.id;
  // No taskType: the conversation is an auto one, so the next message is checked again.
  const act = await call('POST', '/api/chat', { body: { conversationId: id, prompt: 'run the tests and tell me what fails' } });
  assert.equal(act.json.reply.taskType, 'agent');
  assert.equal(runs.at(-1).cwd, projectDir);
  const rule = await call('POST', '/api/chat', { body: { conversationId: id, prompt: 'show me D:\\HomeAI\\notes' } });
  assert.deepEqual([rule.json.reply.taskType, rule.json.reply.auto.via], ['agent', 'rule']);
  const plan = await call('POST', '/api/chat', { body: { conversationId: id, prompt: 'reorganise the project folders' } });
  assert.deepEqual([plan.json.reply.taskType, plan.json.reply.plan], ['plan', true]);
  assert.equal(runs.at(-1).entry.readOnly, true);
  const yes = await call('POST', '/api/chat', { body: { conversationId: id, prompt: 'yes, go ahead' } });
  assert.equal(yes.json.reply.taskType, 'agent');
  assert.match(runs.at(-1).prompt, /Approved plan:\nhello/);
  assert.equal(yes.json.reply.auto.reason, 'go-ahead on a pending plan');
  const conv = await call('GET', `/api/conversations/${id}`);
  assert.equal(conv.json.taskType, 'auto');
  assert.equal(conv.json.messages.at(-2).approved, true);
});

test('auto: devices that cannot run commands always get the chat route; streams report the decision', async () => {
  const phone = await call('POST', '/api/chat', { token: chatToken, body: { prompt: 'run the tests', taskType: 'auto' } });
  assert.equal(phone.status, 200);
  assert.equal(phone.json.reply.taskType, 'quick');
  assert.equal(phone.json.reply.auto.reason, 'this device cannot run commands');
  const s = await sse('/api/chat', { prompt: 'check disk space', taskType: 'auto', stream: true });
  const routed = s.events.find((e) => e.type === 'routed');
  assert.ok(s.events.some((e) => e.type === 'routing'));
  assert.deepEqual([routed.kind, routed.route], ['act', 'agent']);
  assert.equal(s.events.at(-1).type, 'done');
  assert.equal(s.events.at(-1).reply.taskType, 'agent');
});

test('exec, test and git are admin-only; exec streams output', { skip: process.platform !== 'win32' }, async () => {
  assert.equal((await call('POST', '/api/exec', { token: chatToken, body: { command: 'echo hi' } })).status, 403);
  const r = await call('POST', '/api/exec', { body: { command: 'Write-Output "from-api"' } });
  assert.equal(r.status, 200);
  assert.match(r.json.stdout, /from-api/);
  const s = await sse('/api/exec', { command: 'Write-Output "streamed"', stream: true });
  assert.ok(s.events.some((e) => e.type === 'stdout' && /streamed/.test(e.text)));
  assert.equal(s.events.at(-1).type, 'done');
  assert.equal(s.events.at(-1).ok, true);
  const t = await call('POST', '/api/projects/p/test', { body: {} });
  assert.deepEqual([t.json.ok, t.json.pass, t.json.fail], [true, 2, 0]);
  assert.equal((await call('POST', '/api/projects/p/test', { token: chatToken, body: {} })).status, 403);
  assert.equal((await call('POST', '/api/exec', { body: { command: 'dir', cwd: '..' } })).status, 400);
  const list = await call('GET', '/api/projects', { token: readToken });
  assert.equal(list.json.projects[0].name, 'p');
});

test('memory API: admin writes, read scope reads, deletes go to trash', async () => {
  const add = await call('POST', '/api/memory', { body: { title: 'Router', text: 'The router is in the garage', tags: ['home'] } });
  assert.equal(add.status, 200);
  assert.equal((await call('POST', '/api/memory', { token: chatToken, body: { title: 'x', text: 'y' } })).status, 403);
  assert.equal((await call('GET', '/api/memory?q=router', { token: readToken })).json.notes[0].title, 'Router');
  const packet = await call('GET', '/api/memory/context?q=router&maxChars=400', { token: readToken });
  assert.equal(packet.status, 200);
  assert.match(packet.json.text, /garage/);
  assert.ok(packet.json.chars <= 400);
  assert.equal((await call('GET', '/api/memory/context?q=router&maxChars=NaN')).status, 400);
  assert.equal((await call('GET', '/api/memory/context?q=router&maxChars=12001')).status, 400);
  assert.equal((await call('GET', '/api/memory/context?q=router', { token: '' })).status, 401);
  assert.equal((await call('PATCH', `/api/memory/${add.json.id}`, { body: { text: 'Now in the loft' } })).json.text, 'Now in the loft');
  assert.equal((await call('DELETE', `/api/memory/${add.json.id}`)).json.ok, true);
  assert.equal((await call('GET', '/api/memory')).json.notes.length, 0);
  assert.equal((await call('POST', '/api/memory', { body: { title: '', text: 'y' } })).status, 400);
});

test('device API: create returns the token once, list hides hashes, revoke works, devices cannot manage devices', async () => {
  const made = await call('POST', '/api/devices', { body: { name: 'Logan TV', scopes: ['logan'] } });
  assert.equal(made.status, 200);
  assert.match(made.json.token, /^hd_/);
  const list = await call('GET', '/api/devices');
  assert.ok(list.json.devices.some((d) => d.name === 'Logan TV'));
  assert.ok(!JSON.stringify(list.json).includes(made.json.token));
  assert.ok(!list.buf.toString().includes('hash'));
  assert.equal((await call('GET', '/api/devices', { token: chatToken })).status, 403);
  assert.equal((await call('GET', '/api/whoami', { token: made.json.token })).json.scopes[0], 'logan');
  assert.equal((await call('DELETE', `/api/devices/${made.json.device.id}`)).status, 200);
  assert.equal((await call('GET', '/api/whoami', { token: made.json.token })).status, 401);
  assert.equal((await call('POST', '/api/devices', { body: { name: 'x', scopes: ['root'] } })).status, 400);
});

test('GitHub endpoints: reads need read scope; creating issues needs admin', async () => {
  assert.equal((await call('GET', '/api/github', { token: readToken })).json.repo, 'o/r');
  assert.equal((await call('GET', '/api/github/issues?state=closed', { token: readToken })).status, 200);
  assert.deepEqual(githubCalls[0], ['issues', 'closed']);
  assert.equal((await call('POST', '/api/github/issues', { token: chatToken, body: { title: 't' } })).status, 403);
  assert.equal((await call('POST', '/api/github/issues', { body: { title: 't' } })).json.number, 1);
});

test('connections: anyone with read can see state, only admin can log in or out, secrets never come back', async () => {
  assert.equal((await call('GET', '/api/connections', { token: readToken })).json.connections[0].connected, false);
  assert.equal((await call('POST', '/api/connections/github', { token: chatToken, body: { secret: 'good' } })).status, 403);
  assert.equal((await call('POST', '/api/connections/github', { body: { secret: 'bad' } })).status, 400);
  const ok = await call('POST', '/api/connections/github', { body: { secret: 'good' } });
  assert.equal(ok.json.account, 'adam');
  assert.ok(!ok.buf.toString().includes('good'));
  const list = await call('GET', '/api/connections', { token: readToken });
  assert.equal(list.json.connections[0].connected, true);
  assert.ok(!list.buf.toString().includes('good'));
  assert.equal((await call('POST', '/api/connections/github/device', { body: {} })).status, 400); // no client id configured
  assert.equal((await call('DELETE', '/api/connections/github', { token: readToken })).status, 403);
  assert.equal((await call('DELETE', '/api/connections/github')).json.removed, true);
  assert.equal((await call('DELETE', '/api/connections/nope')).status, 404);
  assert.equal((await call('GET', '/api/config', { token: readToken })).json.features.connections, true);
});

test('requests that came through a proxy or from another machine lose admin rights unless remoteAdmin is on', async () => {
  const proxied = { 'x-forwarded-for': '100.64.0.9' };
  assert.equal((await call('PUT', '/api/config/budgets', { headers: proxied, body: {} })).status, 403);
  assert.equal((await call('POST', '/api/exec', { headers: { 'tailscale-user-login': 'a@b' }, body: { command: 'echo' } })).status, 403);
  assert.equal((await call('GET', '/api/config', { headers: proxied })).status, 200);
  assert.equal((await call('POST', '/api/task', { headers: proxied, body: { prompt: 'x' } })).status, 200);
  assert.equal((await call('POST', '/api/task', { headers: proxied, body: { prompt: 'x', taskType: 'agent' } })).status, 403);
});

test('token bootstrap works only for the local WebUI', async () => {
  const ok = await call('GET', '/api/bootstrap', { token: null });
  assert.equal(ok.json.token, ADMIN);
  assert.equal((await call('GET', '/api/bootstrap', { token: null, headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 403);
  assert.equal((await call('GET', '/api/bootstrap', { token: null, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call('GET', '/api/bootstrap', { token: null, headers: { 'tailscale-user-login': 'a@b' } })).status, 403);
  assert.equal((await call('GET', '/api/bootstrap', { token: null, headers: { host: 'evil.example.com' } })).status, 421);
  assert.equal((await call('GET', '/api/bootstrap', { token: null, headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('hostAllowed and isRemote', () => {
  assert.equal(hostAllowed('127.0.0.1:18850'), true);
  assert.equal(hostAllowed('localhost'), true);
  assert.equal(hostAllowed('evil.com'), false);
  assert.equal(hostAllowed('192.168.1.20:18850'), false);
  assert.equal(hostAllowed('192.168.1.20:18850', { allowPrivateIPs: true }), true);
  assert.equal(hostAllowed('100.101.102.103', { allowPrivateIPs: true }), true);
  assert.equal(hostAllowed('8.8.8.8', { allowPrivateIPs: true }), false);
  assert.equal(hostAllowed('PC.tail1234.ts.net:443', { allowedHosts: ['pc.tail1234.ts.net'] }), true);
  assert.equal(hostAllowed('other.ts.net', { allowedHosts: ['pc.tail1234.ts.net'] }), false);
  assert.equal(isRemote({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }), false);
  assert.equal(isRemote({ headers: {}, socket: { remoteAddress: '192.168.1.5' } }), true);
  assert.equal(isRemote({ headers: { via: '1.1 proxy' }, socket: { remoteAddress: '127.0.0.1' } }), true);
});


test('usage reset is restricted to admin devices', async () => {
  assert.equal((await call('POST', '/api/usage/reset', { token: chatToken })).status, 403);
  assert.equal((await call('POST', '/api/usage/reset', { token: readToken })).status, 403);
});

test('memory MCL API: import (admin), export (read), stats', async () => {
  const imp = await call('POST', '/api/memory/mcl', { body: { text: '@adam\n=pc:7900XT\n!be honest;^3' } });
  assert.equal(imp.json.added, 2);
  assert.equal((await call('POST', '/api/memory/mcl', { token: chatToken, body: { text: '=x:y' } })).status, 403);
  assert.equal((await call('POST', '/api/memory/mcl', { body: {} })).status, 400);
  const ex = await call('GET', '/api/memory/mcl', { token: readToken });
  assert.match(ex.json.text, /@adam/);
  assert.equal(ex.json.stats.records, 2);
});
