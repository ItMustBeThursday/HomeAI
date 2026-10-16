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
