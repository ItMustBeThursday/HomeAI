import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpServer, createHttpApi, loadImages, TOOLS } from './mcp.mjs';

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
async function call(server, name, args) {
  const out = JSON.parse(await server.handleLine(rpc(1, 'tools/call', { name, arguments: args })));
  return out.result;
}

test('initialize, ping and tools/list', async () => {
  const s = createMcpServer({ api: async () => ({}), version: '9' });
  const init = JSON.parse(await s.handleLine(rpc(1, 'initialize', { protocolVersion: '2025-03-26' })));
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.serverInfo, { name: 'homeai-orchestrator', version: '9' });
  assert.ok(init.result.capabilities.tools);
  assert.deepEqual(JSON.parse(await s.handleLine(rpc(2, 'ping'))).result, {});
  const list = JSON.parse(await s.handleLine(rpc(3, 'tools/list'))).result.tools;
  for (const name of ['ask', 'chat', 'agent', 'shell', 'run_tests', 'git', 'projects', 'usage', 'status', 'history', 'memory_search', 'memory_add', 'github', 'github_create_issue', 'schedule_run']) {
    const t = list.find((x) => x.name === name);
    assert.ok(t, `missing tool ${name}`);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 20);
  }
  assert.equal(list.length, Object.keys(TOOLS).length);
});

test('notifications get no reply; bad JSON and unknown methods get errors', async () => {
  const s = createMcpServer({ api: async () => ({}) });
  assert.equal(await s.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), '');
  assert.equal(JSON.parse(await s.handleLine('{nope')).error.code, -32700);
  assert.equal(JSON.parse(await s.handleLine('[]')).error.code, -32600);
  assert.equal(JSON.parse(await s.handleLine(rpc(4, 'resources/list'))).error.code, -32601);
  assert.equal(JSON.parse(await s.handleLine(rpc(5, 'tools/call', { name: 'constructor' }))).error.code, -32602);
});

test('memory_context hands a bounded source packet to MCP clients', async () => {
  const sent = [];
  const s = createMcpServer({ api: async (method, path) => { sent.push([method, path]); return { text: '?calibration:0.937;&turn:source:2:0' }; } });
  const r = await call(s, 'memory_context', { query: 'zephyr & calibration', maxChars: 1200 });
  assert.match(r.content[0].text, /0\.937/);
  assert.deepEqual(sent[0], ['GET', '/api/memory/context?q=zephyr%20%26%20calibration&maxChars=1200']);
});

test('ask sends the prompt, route and pinned model and reports who answered', async () => {
  const sent = [];
  const s = createMcpServer({ api: async (m, p, b) => (sent.push([m, p, b]), { ok: true, text: 'Paris', connector: 'local-main', model: 'qwen', taskType: 'general', ms: 1500, attempts: [{}] }) });
  const r = await call(s, 'ask', { prompt: 'capital of France?', route: 'general', model: 'local-main' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^Paris\n\n\[local-main · qwen · route general · 1\.5s\]/);
  assert.deepEqual(sent[0], ['POST', '/api/task', { prompt: 'capital of France?', taskType: 'general', connector: 'local-main', system: undefined, images: undefined }]);
});

test('ask reads image files and sends base64', async () => {
  const sent = [];
  const s = createMcpServer({ api: async (m, p, b) => (sent.push(b), { ok: true, text: 'red', connector: 'c', model: 'm', taskType: 'vision', ms: 1 }), read: () => Buffer.from('IMG') });
  await call(s, 'ask', { prompt: 'color?', images: ['C:\\pics\\dot.PNG'] });
  assert.deepEqual(sent[0].images, [{ name: 'dot.PNG', mediaType: 'image/png', data: Buffer.from('IMG').toString('base64') }]);
  assert.throws(() => loadImages(['x.bmp']), /Unsupported image type/);
});

test('failures come back as tool errors, not protocol errors', async () => {
  const s = createMcpServer({ api: async () => { throw new Error('Missing or wrong bearer token'); } });
  const r = await call(s, 'status', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /bearer token/);
  const failed = createMcpServer({ api: async () => ({ ok: false, error: 'Every connector failed', connector: undefined, model: undefined, taskType: 'general', ms: 5 }) });
  assert.equal((await call(failed, 'ask', { prompt: 'x' })).isError, true);
});

test('shell, run_tests and git format output and flag non-zero exits as errors', async () => {
  const api = async (m, p) => {
    if (p === '/api/exec') return { ok: false, code: 2, stdout: 'out', stderr: 'bad', ms: 100, cwd: 'D:\\p' };
    if (p.endsWith('/test')) return { ok: true, pass: 7, fail: 0, stdout: '# pass 7', stderr: '' };
    return { ok: true, code: 0, stdout: 'On branch main', stderr: '', ms: 5 };
  };
  const s = createMcpServer({ api });
  const sh = await call(s, 'shell', { command: 'x', timeoutSeconds: 5 });
  assert.equal(sh.isError, true);
  assert.match(sh.content[0].text, /exit 2[\s\S]*out[\s\S]*\[stderr\]\nbad/);
  const t = await call(s, 'run_tests', { project: 'orchestrator' });
  assert.match(t.content[0].text, /^PASS · pass 7 · fail 0/);
  assert.match((await call(s, 'git', { project: 'p', action: 'status' })).content[0].text, /On branch main/);
});

test('projects, usage, history, memory and github tools render readable text', async () => {
  const api = async (m, p) => {
    if (p === '/api/projects') return { default: 'a', projects: [{ name: 'a', path: 'D:\\a', canTest: true, canSync: false, git: true, description: 'Alpha' }] };
    if (p.startsWith('/api/usage')) return { hours: 24, total: { calls: 3, inputTokens: 10, outputTokens: 5 }, byConnector: { x: { calls: 3, inputTokens: 10, outputTokens: 5 } }, caps: [{ scope: 'connector', name: 'x', metric: 'calls', used: 3, limit: 10 }] };
    if (p.startsWith('/api/history')) return { tasks: [{ ts: 0, ok: true, taskType: 'quick', connector: 'x', ms: 1000, prompt: 'hello\nworld' }] };
    if (p.startsWith('/api/memory')) return m === 'POST' ? { id: 'n1' } : { notes: [{ id: 'n1', title: 'T', tags: ['core'], text: 'body' }] };
    if (p === '/api/github') return { repo: 'o/r' };
    return { ok: true };
  };
  const s = createMcpServer({ api });
  assert.match((await call(s, 'projects', {})).content[0].text, /^a \(default\): D:\\a · tests · git — Alpha/);
  assert.match((await call(s, 'usage', {})).content[0].text, /3 calls[\s\S]*connector x calls: 3\/10/);
  assert.match((await call(s, 'history', {})).content[0].text, /ok  quick → x 1\.0s: hello world/);
  assert.match((await call(s, 'memory_search', { query: 'body' })).content[0].text, /\[n1\] T \(core\): body/);
  assert.equal((await call(s, 'memory_add', { title: 'a', text: 'b' })).content[0].text, 'Saved note n1.');
  assert.match((await call(s, 'github', { what: 'summary' })).content[0].text, /o\/r/);
});

test('createHttpApi sends the bearer token and surfaces API errors', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push([url, init]), url.endsWith('/bad') ? { ok: false, status: 403, json: async () => ({ error: 'needs admin' }) } : { ok: true, json: async () => ({ fine: 1 }) });
  const api = createHttpApi({ baseUrl: 'http://x', token: 'T', fetchImpl });
  assert.deepEqual(await api('POST', '/api/a', { q: 1 }), { fine: 1 });
  assert.equal(seen[0][1].headers.authorization, 'Bearer T');
  assert.equal(seen[0][1].headers['content-type'], 'application/json');
  await assert.rejects(api('GET', '/bad'), /needs admin/);
});

test('the real stdio server answers over a pipe and talks to the HTTP API with the token file', async () => {
  const seen = [];
  const api = createServer((req, res) => {
    seen.push([req.method, req.url, req.headers.authorization]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ connectors: { x: { model: 'm', ok: true } } }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
  const tokenFile = join(dir, 'token.txt');
  writeFileSync(tokenFile, 'tok-from-file\n');
  const script = join(dirname(fileURLToPath(import.meta.url)), 'mcp.mjs');
  const child = spawn(process.execPath, [script], { env: { ...process.env, HOMEAI_ORCH_URL: `http://127.0.0.1:${api.address().port}`, HOMEAI_ORCH_TOKEN_FILE: tokenFile, HOMEAI_ORCH_TOKEN: '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = [];
  let buf = '';
  child.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) if (l.trim()) replies.push(JSON.parse(l));
  });
  child.stdin.write(rpc(1, 'initialize', {}) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(rpc(2, 'tools/call', { name: 'status', arguments: {} }) + '\n');
  for (let i = 0; i < 100 && replies.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  api.close();
  assert.equal(replies.length, 2);
  assert.equal(replies[0].result.serverInfo.name, 'homeai-orchestrator');
  assert.match(replies[1].result.content[0].text, /x \(m\): ready/);
  assert.equal(seen[0][2], 'Bearer tok-from-file');
});
