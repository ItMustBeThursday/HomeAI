import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { validateSchedule, isDue, createScheduler } from './scheduler.mjs';

const at = (h, m = 0) => new Date(2026, 9, 15, h, m, 0, 0).getTime();
const job = { name: 'backup', dailyAt: '03:00', command: ['x', '1'] };

function fakeSpawn({ code = 0, out = 'done', err = '', calls = [] } = {}) {
  const fn = (cmd, args) => {
    calls.push([cmd, ...args]);
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => c.stdout;
    c.stderr = new EventEmitter(); c.stderr.setEncoding = () => c.stderr;
    c.stdin = Object.assign(new EventEmitter(), { end() {} });
    c.kill = () => {};
    setImmediate(() => { c.stdout.emit('data', out); c.stderr.emit('data', err); c.emit('close', code); });
    return c;
  };
  fn.calls = calls;
  return fn;
}

test('validateSchedule accepts good config and rejects bad ones', () => {
  assert.ok(validateSchedule({ enabled: false, jobs: [job] }));
  assert.throws(() => validateSchedule({ jobs: [{ ...job, dailyAt: '25:00' }] }), /HH:MM/);
  assert.throws(() => validateSchedule({ jobs: [{ ...job, everyMinutes: 5 }] }), /exactly one/);
  assert.throws(() => validateSchedule({ jobs: [{ name: 'a', everyMinutes: 0, command: ['x'] }] }), /positive integer/);
  assert.throws(() => validateSchedule({ jobs: [{ ...job, command: [] }] }), /command/);
  assert.throws(() => validateSchedule({ jobs: [job, job] }), /Duplicate/);
  assert.throws(() => validateSchedule({ nope: 1 }), /Unknown schedule key/);
});

test('isDue: daily waits for its time, runs once, and catches up after a miss', () => {
  assert.equal(isDue(job, undefined, at(2, 59)), false);
  assert.equal(isDue(job, undefined, at(3, 0)), true);
  assert.equal(isDue(job, at(3, 0), at(3, 30)), false);
  assert.equal(isDue(job, at(3, 0), at(23, 0)), false);
  assert.equal(isDue(job, at(3, 0) - 86_400_000, at(9, 0)), true); // yesterday's run, PC was off at 03:00
});

test('isDue: interval jobs', () => {
  const j = { name: 'i', everyMinutes: 10, command: ['x'] };
  assert.equal(isDue(j, undefined, 0), true);
  assert.equal(isDue(j, 0, 9 * 60_000), false);
  assert.equal(isDue(j, 0, 10 * 60_000), true);
});

test('tick runs due jobs once, records results, and does nothing when disabled', async () => {
  const records = [];
  let t = at(3, 5);
  const sp = fakeSpawn();
  const s = createScheduler({ config: { enabled: true, jobs: [job] }, record: (e) => records.push(e), now: () => t, spawnImpl: sp });
  const ran = await s.tick();
  assert.equal(ran.length, 1);
  assert.deepEqual(sp.calls, [['x', '1']]);
  assert.equal(records[0].ok, true);
  assert.equal((await s.tick()).length, 0);
  const off = createScheduler({ config: { enabled: false, jobs: [job] }, now: () => t, spawnImpl: fakeSpawn() });
  assert.deepEqual(await off.tick(), []);
});

test('a failing command is recorded as failed with its stderr', async () => {
  const records = [];
  const s = createScheduler({ config: { enabled: true, jobs: [job] }, record: (e) => records.push(e), now: () => at(4), spawnImpl: fakeSpawn({ code: 2, err: 'bad thing' }) });
  await s.tick();
  assert.equal(records[0].ok, false);
  assert.equal(records[0].code, 2);
  assert.match(records[0].output, /bad thing/);
});

test('lastRuns seed prevents a re-run after restart; runNow works even when disabled', async () => {
  const sp = fakeSpawn();
  const s = createScheduler({ config: { enabled: true, jobs: [job] }, lastRuns: { backup: at(3, 1) }, now: () => at(5), spawnImpl: sp });
  assert.deepEqual(await s.tick(), []);
  const off = createScheduler({ config: { enabled: false, jobs: [job] }, now: () => at(5), spawnImpl: sp });
  const r = await off.runNow('backup');
  assert.equal(r.ok, true);
  await assert.rejects(off.runNow('nope'), /Unknown job/);
  assert.equal(off.list().jobs[0].lastRun.ok, true);
});
