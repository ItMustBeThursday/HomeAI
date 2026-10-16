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

test('NEEDS_ACCESS parks the job; "once" resumes with the folder for this job only', async () => {
  const seen = [];
  const jobs = make(async ({ job, prompt }) => {
    seen.push({ prompt, grants: [...job.grants] });
    return job.grants.length ? ok('finished with D:\\Games') : ok('Cannot continue.\nNEEDS_ACCESS: D:\\Games | need the save files');
  });
  const j = jobs.add({ prompt: 'back up saves', project: 'p' });
  await jobs.idle();
  let d = jobs.get(j.id);
  assert.equal(d.status, 'needs-access');
  assert.deepEqual({ path: d.access.path, reason: d.access.reason }, { path: 'D:\\Games', reason: 'need the save files' });
  jobs.resolveAccess(j.id, 'once');
  await jobs.idle();
  d = jobs.get(j.id);
  assert.equal(d.status, 'done');
  assert.deepEqual(d.grants, ['D:\\Games']);
  assert.match(seen[1].prompt, /Folder access now granted.*D:\\Games/);
  assert.throws(() => jobs.resolveAccess(j.id, 'once'), /not waiting/);
});

test('"always" saves the folder through grantAlways; "deny" tells the agent and never asks again', async () => {
  const saved = [];
  const prompts = [];
  const jobs = make(async ({ prompt }) => (prompts.push(prompt), ok('x\nNEEDS_ACCESS: D:\\Music')), { grantAlways: (p) => saved.push(p) });
  const a = jobs.add({ prompt: 'one', project: 'a' });
  await jobs.idle();
  jobs.resolveAccess(a.id, 'always');
  await jobs.idle();
  assert.deepEqual(saved, ['D:\\Music']);
  // already granted to this job, so the repeat request is not raised again
  assert.equal(jobs.get(a.id).status, 'done');

  const b = jobs.add({ prompt: 'two', project: 'b' });
  await jobs.idle();
  assert.equal(jobs.get(b.id).status, 'needs-access');
  jobs.resolveAccess(b.id, 'deny');
  await jobs.idle();
  assert.equal(jobs.get(b.id).status, 'done');
  assert.match(prompts.at(-1), /was denied/);
});

test('tool denials raise an access request for the refused file\'s folder; off-limits folders are not offered', async () => {
  const vet = (p) => { if (/one.?drive/i.test(p)) throw new Error('that cloud folder is off limits'); return p; };
  const odPath = ['C:', 'Users', 'x', 'One' + 'Drive', 'b.txt'].join('\\');
  const jobs = make(async ({ job }) => ok('could not read it', { denials: job.grants.length ? [] : [{ tool: 'Read', path: odPath }, { tool: 'Read', path: 'E:\\Data\\notes\\a.txt' }] }), { vetFolder: vet });
  const j = jobs.add({ prompt: 'read it', project: 'p' });
  await jobs.idle();
  const d = jobs.get(j.id);
  assert.equal(d.status, 'needs-access');
  assert.equal(d.access.path, 'E:\\Data\\notes');
  assert.ok(d.log.some((l) => /Not asking for.*off limits/.test(l.msg)));
});

test('a note added while running is applied before the job counts as done', async () => {
  const prompts = [];
  let jobs;
  jobs = make(async ({ job, prompt }) => {
    prompts.push(prompt);
    if (prompts.length === 1) jobs.addNote(job.id, 'also update the README');
    return ok(`round ${prompts.length}`);
  });
  const j = jobs.add({ prompt: 'build it', project: 'p' });
  await jobs.idle();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /also update the README/);
  assert.equal(jobs.get(j.id).status, 'done');
  assert.equal(jobs.get(j.id).result.text, 'round 2');
});

test('apply-now interrupts the running job and resumes it with the note', async () => {
  const prompts = [];
  let jobs;
  jobs = make(({ job, prompt, signal }) => {
    prompts.push(prompt);
    if (prompts.length > 1) return Promise.resolve(ok('done with note'));
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, error: 'Cancelled', text: 'half way' }));
      setTimeout(() => jobs.addNote(job.id, 'use tabs', { apply: 'now' }), 5);
    });
  });
  const j = jobs.add({ prompt: 'format code', project: 'p' });
  await jobs.idle();
  const d = jobs.get(j.id);
  assert.equal(d.status, 'done');
  assert.equal(d.attempts, 1);
  assert.match(prompts[1], /use tabs/);
  assert.match(prompts[1], /half way/);
});

test('a note on a finished job can re-queue it to continue; without apply it is just recorded', async () => {
  const prompts = [];
  const jobs = make(async ({ prompt }) => (prompts.push(prompt), ok(`result ${prompts.length}`)));
  const j = jobs.add({ prompt: 'write docs', project: 'p' });
  await jobs.idle();
  jobs.addNote(j.id, 'remember to mention setup');
  assert.equal(jobs.get(j.id).status, 'done');
  jobs.addNote(j.id, 'and troubleshooting', { apply: 'now' });
  await jobs.idle();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /mention setup/);
  assert.match(prompts[1], /troubleshooting/);
  assert.match(prompts[1], /result 1/);
  assert.throws(() => jobs.addNote(j.id, '  '), /non-empty/);
});

test('needs-access jobs survive clearFinished', async () => {
  const jobs = make(async () => ok('NEEDS_ACCESS: D:\\Games'));
  const j = jobs.add({ prompt: 'x', project: 'p' });
  await jobs.idle();
  assert.equal(jobs.clearFinished().cleared, 0);
  assert.equal(jobs.get(j.id).status, 'needs-access');
});
