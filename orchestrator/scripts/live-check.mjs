// Live end-to-end check against the RUNNING service (real Claude, Codex, Ollama, shell). Costs a few tiny model calls.
// Usage: node scripts/live-check.mjs [baseUrl]   (admin token is read from data/token.txt)
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://127.0.0.1:18850';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const token = readFileSync(join(root, 'data', 'token.txt'), 'utf8').trim();
const results = [];
const check = async (name, fn) => {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, s: ((Date.now() - t) / 1000).toFixed(1) });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message, s: ((Date.now() - t) / 1000).toFixed(1) });
  }
  const r = results.at(-1);
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name} (${r.s}s) ${String(r.detail ?? '').slice(0, 160)}`);
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const call = async (path, { method = 'GET', body, auth = token } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
async function sse(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }) });
  assert(res.ok, `HTTP ${res.status}`);
  const text = await res.text();
  return text.split('\n\n').map((f) => f.split('\n').find((l) => l.startsWith('data: '))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
}

// 16x16 solid red PNG
function redPng() {
  const crc = (buf) => { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 64 }, () => [255, 0, 0]).flat())]);
  const raw = Buffer.concat(Array.from({ length: 64 }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

await check('auth required', async () => { const r = await call('/api/config', { auth: '' }); assert(r.status === 401, `status ${r.status}`); });
await check('bootstrap works on loopback', async () => { const r = await call('/api/bootstrap', { auth: '' }); assert(r.status === 200 && r.json.token === token, `status ${r.status}`); return 'ok'; });
await check('bootstrap refused via proxy header', async () => { const res = await fetch(`${base}/api/bootstrap`, { headers: { 'x-forwarded-for': '1.2.3.4' } }); assert(res.status === 403, `status ${res.status}`); });
await check('foreign Host refused', async () => {
  const { request } = await import('node:http');
  const u = new URL(base);
  const status = await new Promise((resolve, reject) => { const r = request({ host: u.hostname, port: u.port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.end(); });
  assert(status === 421, `status ${status}`);
});

await check('local Ollama streaming', async () => {
  const ev = await sse('/api/task', { taskType: 'quick', connector: 'local-fast', prompt: 'Reply with exactly: pong' });
  const done = ev.find((e) => e.type === 'done');
  assert(done?.ok, JSON.stringify(done)); return `${done.connector}: ${done.text.trim().slice(0, 40)}`;
});
await check('Claude streaming (deltas)', async () => {
  const ev = await sse('/api/task', { taskType: 'quick', connector: 'claude-haiku', prompt: 'Reply with exactly: pong' });
  const done = ev.find((e) => e.type === 'done');
  assert(done?.ok, JSON.stringify(done)); return `${ev.filter((e) => e.type === 'delta').length} deltas; ${done.text.trim().slice(0, 40)}`;
});
await check('Codex (standalone install)', async () => {
  const ev = await sse('/api/task', { taskType: 'coding', connector: 'codex', prompt: 'Reply with exactly: pong' });
  const done = ev.find((e) => e.type === 'done');
  assert(done?.ok, JSON.stringify(done)); return `${done.connector}: ${done.text.trim().slice(0, 40)}`;
});
await check('Vision via Claude (red image)', async () => {
  const data = redPng().toString('base64');
  const ev = await sse('/api/task', { taskType: 'vision', connector: 'claude-haiku', prompt: 'What single colour is this image? One word.', images: [{ name: 'red.png', mediaType: 'image/png', data }] });
  const done = ev.find((e) => e.type === 'done');
  assert(done?.ok, JSON.stringify(done)); assert(/red/i.test(done.text), `answer: ${done.text}`); return done.text.trim();
});
await check('Vision via local model (red image)', async () => {
  const data = redPng().toString('base64');
  const ev = await sse('/api/task', { taskType: 'vision', connector: 'local-vision', prompt: 'What single colour is this image? One word.', images: [{ name: 'red.png', mediaType: 'image/png', data }] });
  const done = ev.find((e) => e.type === 'done');
  assert(done?.ok, JSON.stringify(done)); return done.text.trim().slice(0, 40);
});
await check('Shell exec streams output', async () => {
  const ev = await sse('/api/exec', { command: 'node --version', project: 'orchestrator' });
  const done = ev.find((e) => e.type === 'done');
  assert(done?.code === 0 && ev.some((e) => e.type === 'stdout'), JSON.stringify(done)); return ev.find((e) => e.type === 'stdout').text.trim();
});
await check('OneDrive refused', async () => { const r = await call('/api/exec', { method: 'POST', body: { command: 'dir C:\\Users\\x\\OneDrive', project: 'orchestrator' } }); assert(r.status === 400, `status ${r.status}`); });
await check('Project tests via API', async () => {
  const ev = await sse('/api/projects/orchestrator/test', {});
  const done = ev.find((e) => e.type === 'done'); assert(done?.code === 0, `exit ${done?.code}`); return 'tests pass';
});
await check('git status', async () => { const ev = await sse('/api/projects/homeai-repo/git', { action: 'status' }); const done = ev.find((e) => e.type === 'done'); assert(done?.code === 0, JSON.stringify(done)); return ev.find((e) => e.type === 'stdout')?.text.split('\n')[0]; });
await check('GitHub read', async () => { const r = await call('/api/github'); assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.json)}`); return `${r.json.repo} ${r.json.openIssues} open`; });
await check('Agent route can run a command in a project', async () => {
  const ev = await sse('/api/task', { taskType: 'agent', prompt: 'Run `node --version` in the shell and tell me the version it prints. Do not change any files.', project: 'workspace' });
  const done = ev.find((e) => e.type === 'done');
  assert(done?.ok, JSON.stringify(done)); assert(/v?24\./.test(done.text), `answer: ${done.text}`); return `${ev.filter((e) => e.type === 'tool').length} tool events; ${done.text.trim().slice(0, 60)}`;
});
await check('Device token scopes (chat cannot use shell)', async () => {
  const mk = await call('/api/devices', { method: 'POST', body: { name: 'live-check', scopes: ['chat'] } });
  assert(mk.status === 200, `create ${mk.status}`);
  try {
    const ex = await call('/api/exec', { method: 'POST', body: { command: 'echo hi' }, auth: mk.json.token });
    const ag = await call('/api/task', { method: 'POST', body: { taskType: 'agent', prompt: 'hi' }, auth: mk.json.token });
    const cfg = await call('/api/config', { auth: mk.json.token });
    assert(ex.status === 403 && ag.status === 403 && cfg.status === 200, `exec ${ex.status} agent ${ag.status} config ${cfg.status}`);
  } finally { await call(`/api/devices/${mk.json.device.id}`, { method: 'DELETE' }); }
  return 'chat token: shell 403, agent 403, read ok; token revoked';
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
