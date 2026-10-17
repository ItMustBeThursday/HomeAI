import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from './access.mjs';
import { createPairing } from './pairing.mjs';

const mk = (extra = {}) => {
  let t = 1000;
  const auth = createAuth({ adminToken: 'a'.repeat(32) });
  const p = createPairing({ auth, now: () => t, rand: () => 42, ...extra });
  return { auth, p, tick: (ms) => (t += ms) };
};

test('claim issues a read+chat device token, once', () => {
  const { auth, p } = mk();
  const { code } = p.start();
  assert.equal(code, '000042');
  const { token, device } = p.claim(code, 'Pixel');
  assert.deepEqual(device.scopes, ['read', 'chat']);
  const id = auth.identify(`Bearer ${token}`);
  assert.equal(id.scopes.has('admin'), false);
  assert.equal(id.scopes.has('chat'), true);
  assert.throws(() => p.claim(code, 'Again'), (e) => e.status === 403);
});

test('codes expire and a new start replaces the old code', () => {
  const { p, tick } = mk({ ttlMs: 1000 });
  const { code } = p.start();
  tick(1001);
  assert.throws(() => p.claim(code, 'x'), (e) => e.status === 403);
  p.start();
  assert.ok(p.pending());
  p.cancel();
  assert.equal(p.pending(), null);
});

test('repeated wrong codes lock claiming, even for the right code', () => {
  const { p, tick } = mk({ maxFailures: 3, lockMs: 10_000 });
  const { code } = p.start();
  for (let i = 0; i < 3; i++) assert.throws(() => p.claim('999999', 'x'), (e) => e.status === 403);
  assert.throws(() => p.claim(code, 'x'), (e) => e.status === 429);
  tick(10_001);
  p.start();
  assert.ok(p.claim('000042', 'x').token);
});

test('a device name is required', () => {
  const { p } = mk();
  const { code } = p.start();
  assert.throws(() => p.claim(code, ' '), (e) => e.status === 400);
});
