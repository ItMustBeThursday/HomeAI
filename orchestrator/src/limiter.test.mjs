import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from './limiter.mjs';

const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};

test('runs up to the limit at once and queues the rest in order', async () => {
  const lim = createLimiter({ limits: { a: 2 } });
  const order = [];
  const gates = [gate(), gate(), gate()];
  const jobs = gates.map((g, i) => lim.run('a', async () => { order.push(`start${i}`); await g.p; order.push(`end${i}`); return i; }));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['start0', 'start1']);
  assert.deepEqual(lim.stats().a, { active: 2, queued: 1, limit: 2 });
  gates[0].open();
  await jobs[0];
  await new Promise((r) => setImmediate(r));
  assert.ok(order.includes('start2'));
  gates[1].open();
  gates[2].open();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2]);
  assert.equal(lim.stats().a.active, 0);
});

test('keys are independent and unknown keys use the fallback', async () => {
  const lim = createLimiter({ limits: { a: 1 }, fallback: 1 });
  const g = gate();
  const first = lim.run('a', () => g.p);
  let ranB = false;
  await lim.run('b', async () => { ranB = true; });
  assert.ok(ranB);
  g.open();
  await first;
});

test('a rejection frees the slot', async () => {
  const lim = createLimiter();
  await assert.rejects(lim.run('x', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await lim.run('x', async () => 'ok'), 'ok');
});

test('rejects invalid limits', () => {
  assert.throws(() => createLimiter({ limits: { a: 0 } }), /positive integer/);
  assert.throws(() => createLimiter({ fallback: 1.5 }), /positive integer/);
});
