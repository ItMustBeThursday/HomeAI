import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobs, continuePrompt } from './jobs.mjs';

const make = (run, opts = {}) => {
  let n = 0;
  return createJobs({ run, newId: () => `j${++n}`, retryDelayMs: 1, ...opts });
};
const ok = (text = 'done', extra = {}) => ({ ok: true, text, connector: 'c', model: 'm', taskId: 't', ...extra });

test('a queued job runs to completion with no further input', async () => {
  const jobs = make(async () => ok('all finished'));
  const j = jobs.add({ prompt: 'do the thing', project: 'p' });
  await jobs.idle();
  const done = jobs.get(j.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result.text, 'all finished');
  assert.equal(done.attempts, 1);
});

test('rejects an empty prompt; addMany reports bad entries and queues the rest', async () => {
  const jobs = make(async () => ok());
  assert.throws(() => jobs.add({ prompt: '  ' }), /prompt/);
  const out = jobs.addMany([{ prompt: 'a' }, { prompt: '' }, { prompt: 'b' }]);
  assert.deepEqual(out.map((o) => o.ok), [true, false, true]);
  await jobs.idle();
  assert.equal(jobs.list().filter((j) => j.status === 'done').length, 2);
});

test('running out of turns continues the job instead of stopping', async () => {
  const prompts = [];
  const jobs = make(async ({ prompt, onEvent }) => {
    prompts.push(prompt);
    if (prompts.length < 3) {
      onEvent({ type: 'tool', name: 'edit', summary: `file${prompts.length}.js` });
      return { ok: false, error: 'Reached max turns (40)', text: `progress ${prompts.length}` };
    }
    return ok('complete');
  });
  const j = jobs.add({ prompt: 'big refactor', project: 'p' });
  await jobs.idle();
  const d = jobs.get(j.id);
  assert.equal(d.status, 'done');
  assert.equal(d.continues, 2);
  assert.equal(d.attempts, 1, 'continuing is not a retry');
  assert.match(prompts[1], /Continue the task/);
  assert.match(prompts[1], /big refactor/);
  assert.match(prompts[2], /edit: file2\.js/);
  assert.match(prompts[2], /progress 2/);
});

test('other failures retry with backoff, then fail after maxAttempts', async () => {
  let calls = 0;
  const jobs = make(async () => (++calls, { ok: false, error: 'boom' }), { maxAttempts: 3 });
  const j = jobs.add({ prompt: 'x' });
  await jobs.idle();
  const d = jobs.get(j.id);
  assert.equal(calls, 3);
  assert.equal(d.status, 'failed');
  assert.equal(d.error, 'boom');
  let flaky = 0;
  const j2 = make(async () => (++flaky < 2 ? { ok: false, error: 'blip' } : ok()));
  const a = j2.add({ prompt: 'y' });
  await j2.idle();
  assert.equal(j2.get(a.id).status, 'done');
});

test('continuations are capped', async () => {
  let calls = 0;
  const jobs = make(async () => (++calls, { ok: false, error: 'max turns' }), { maxContinues: 2, maxAttempts: 1 });
  const j = jobs.add({ prompt: 'x' });
  await jobs.idle();
  assert.equal(calls, 3);
  assert.equal(jobs.get(j.id).status, 'failed');
});

test('NEEDS_INPUT is the only deliberate stop, and retry with guidance resumes it', async () => {
  let n = 0;
  const jobs = make(async ({ prompt }) => (++n === 1 ? ok('Stopped.\nNEEDS_INPUT: which branch should I push to?') : ok(`pushed (${/Extra guidance:\nmain/.test(prompt)})`)));
  const j = jobs.add({ prompt: 'publish it' });
  await jobs.idle();
  assert.deepEqual([jobs.get(j.id).status, jobs.get(j.id).question], ['needs-input', 'which branch should I push to?']);
  jobs.retry(j.id, 'main');
  await jobs.idle();
  assert.equal(jobs.get(j.id).status, 'done');
  assert.equal(jobs.get(j.id).result.text, 'pushed (true)');
});

test('planFirst plans and then carries the plan out without waiting for approval', async () => {
  const steps = [];
  const jobs = make(async ({ step, prompt }) => {
    steps.push(step);
    return step === 'plan' ? ok('1. do A\n2. do B') : (assert.match(prompt, /1\. do A/), ok('executed'));
  });
  const j = jobs.add({ prompt: 'reorganise', project: 'p', planFirst: true });
  await jobs.idle();
  assert.deepEqual(steps, ['plan', 'work']);
  assert.equal(jobs.get(j.id).status, 'done');
});

test('concurrency limit, and one running job per project', async () => {
  let active = 0;
  let peak = 0;
  const byProject = {};
  const jobs = make(async ({ job }) => {
    active += 1;
    peak = Math.max(peak, active);
    byProject[job.project] = (byProject[job.project] ?? 0) + 1;
    assert.ok(byProject[job.project] <= 1, 'two jobs in one project at once');
    await new Promise((r) => setTimeout(r, 15));
    byProject[job.project] -= 1;
    active -= 1;
    return ok();
  }, { concurrency: 2 });
  jobs.addMany([{ prompt: 'a', project: 'x' }, { prompt: 'b', project: 'x' }, { prompt: 'c', project: 'y' }, { prompt: 'd', project: 'z' }]);
  await jobs.idle();
  assert.equal(peak, 2);
  assert.equal(jobs.list().every((j) => j.status === 'done'), true);
});

test('cancel works on queued and running jobs', async () => {
  const jobs = make(({ signal }) => new Promise((res) => signal.addEventListener('abort', () => res({ ok: false, error: 'Cancelled', cancelled: true })))
    , { concurrency: 1 });
  const a = jobs.add({ prompt: 'long' });
  const b = jobs.add({ prompt: 'waits' });
  assert.equal(jobs.get(b.id).status, 'queued');
  jobs.cancel(b.id);
  jobs.cancel(a.id);
  await jobs.idle();
  assert.deepEqual([jobs.get(a.id).status, jobs.get(b.id).status], ['cancelled', 'cancelled']);
  assert.throws(() => jobs.cancel(a.id), /already cancelled/);
  assert.throws(() => jobs.get('nope'), /not found/);
});

test('jobs persist; a job that was running resumes after a restart', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jobs-')), 'jobs.json');
  const first = make(() => new Promise(() => {}), { file });
  const j = first.add({ prompt: 'survive restarts', project: 'p' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs[0].status, 'running');
  const prompts = [];
  const second = make(async ({ prompt }) => (prompts.push(prompt), ok('resumed ok')), { file });
  assert.equal(second.get(j.id).status, 'queued');
  second.start();
  await second.idle();
  assert.equal(second.get(j.id).status, 'done');
  assert.match(prompts[0], /Continue the task/);
  assert.ok(second.get(j.id).log.some((l) => /restarted/i.test(l.msg)));
});

test('a corrupt jobs file is set aside, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const file = join(dir, 'jobs.json');
  writeFileSync(file, '{not json');
  const jobs = make(async () => ok(), { file });
  assert.deepEqual(jobs.list(), []);
});

test('clearFinished keeps active and needs-input jobs; pause stops new starts', async () => {
  const jobs = make(async ({ prompt }) => ok(/ask/.test(prompt) ? 'NEEDS_INPUT: ?' : 'fine'));
  jobs.addMany([{ prompt: 'one' }, { prompt: 'ask me' }]);
  await jobs.idle();
  assert.deepEqual(jobs.clearFinished(), { cleared: 1 });
  assert.equal(jobs.list().length, 1);
  jobs.pause();
  const p = jobs.add({ prompt: 'later' });
  assert.equal(jobs.get(p.id).status, 'queued');
  jobs.resume();
  await jobs.idle();
  assert.equal(jobs.get(p.id).status, 'done');
});

test('continuePrompt includes the task, recent actions and last output', () => {
  const t = continuePrompt({ prompt: 'T', progress: ['a', 'b'], partial: 'last words', plan: 'P' });
  assert.match(t, /T/);
  assert.match(t, /- b/);
  assert.match(t, /last words/);
  assert.match(t, /Approved plan:\nP/);
});
