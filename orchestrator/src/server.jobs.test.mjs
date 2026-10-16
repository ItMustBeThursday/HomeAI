import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';
import { createJobs } from './jobs.mjs';

let server;
let base;
const jobs = createJobs({ run: async ({ job }) => ({ ok: true, text: `ran ${job.project}` }), retryDelayMs: 1 });
const shell = { default: 'home', resolveCwd: () => 'x', projects: () => [] };

before(async () => {
  server = await startServer({ orchestrator: { config: { connectors: {}, routes: {}, default: 'x' }, isAgentRoute: () => false, queue: () => ({}) }, jobs, shell }, { port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('jobs API: queue one or many, default project filled in, runs to done, retry and clear', async () => {
  const one = await call('POST', '/api/jobs', { prompt: 'first' });
  assert.equal(one.status, 200);
  assert.equal(one.body.project, 'home');
  const many = await call('POST', '/api/jobs', { jobs: [{ prompt: 'a', project: 'p1' }, { prompt: '' }] });
  assert.deepEqual(many.body.results.map((r) => r.ok), [true, false]);
  await jobs.idle();
  const list = await call('GET', '/api/jobs');
  assert.equal(list.body.jobs.length, 2);
  assert.ok(list.body.jobs.every((j) => j.status === 'done'));
  const detail = await call('GET', `/api/jobs/${one.body.id}`);
  assert.equal(detail.body.result.text, 'ran home');
  assert.equal((await call('GET', '/api/jobs/nope')).status, 404);
  assert.equal((await call('POST', `/api/jobs/${one.body.id}/cancel`, {})).status, 400);
  assert.equal((await call('POST', '/api/jobs', { prompt: '' })).status, 400);
  assert.deepEqual((await call('POST', '/api/jobs/clear', {})).body, { cleared: 2 });
});

test('jobs API is 404 when the feature is off', async () => {
  const s = await startServer({ orchestrator: { config: { connectors: {}, routes: {}, default: 'x' }, isAgentRoute: () => false } }, { port: 0 });
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/jobs`);
  assert.equal(res.status, 404);
  s.close();
});

test('notes, access decisions and standing grants over the API', async () => {
  const saved = [];
  const j2 = createJobs({ run: async ({ job }) => ({ ok: true, text: job.grants.length ? 'ok' : 'NEEDS_ACCESS: D:\Games | saves' }), retryDelayMs: 1, grantAlways: (p) => saved.push(p) });
  const store = [];
  const grants = { list: () => store, add: ({ path }) => { const f = { id: `g${store.length + 1}`, path, write: true }; store.push(f); return f; }, remove: (id) => { if (!store.some((f) => f.id === id)) throw new Error('Grant not found'); store.splice(0, store.length, ...store.filter((f) => f.id !== id)); } };
  const s = await startServer({ orchestrator: { config: { connectors: {}, routes: {}, default: 'x' }, isAgentRoute: () => false, queue: () => ({}) }, jobs: j2, grants, shell }, { port: 0 });
  const b = `http://127.0.0.1:${s.address().port}`;
  const go = async (method, path, body) => {
    const res = await fetch(b + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const q = await go('POST', '/api/jobs', { prompt: 'save games' });
  await j2.idle();
  assert.equal((await go('GET', `/api/jobs/${q.body.id}`)).body.status, 'needs-access');
  assert.equal((await go('POST', `/api/jobs/${q.body.id}/access`, { decision: 'maybe' })).status, 400);
  assert.equal((await go('POST', `/api/jobs/${q.body.id}/notes`, { text: '' })).status, 400);
  assert.equal((await go('POST', `/api/jobs/${q.body.id}/notes`, { text: 'be quick' })).status, 200);
  assert.equal((await go('POST', `/api/jobs/${q.body.id}/access`, { decision: 'always' })).status, 200);
  await j2.idle();
  assert.equal((await go('GET', `/api/jobs/${q.body.id}`)).body.status, 'done');
  assert.deepEqual(saved, ['D:\Games']);
  const added = await go('POST', '/api/access', { path: 'D:\Music' });
  assert.equal(added.body.path, 'D:\Music');
  assert.equal((await go('GET', '/api/access')).body.folders.length, 1);
  assert.equal((await go('DELETE', `/api/access/${added.body.id}`)).status, 200);
  assert.equal((await go('DELETE', '/api/access/zzz')).status, 404);
  s.close();
});
