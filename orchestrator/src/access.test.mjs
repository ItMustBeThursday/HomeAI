import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuth, loadOrCreateToken, can } from './access.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'acc-'));

test('admin token is created once, reused, and has every scope', () => {
  const file = join(tmp(), 'token.txt');
  const t = loadOrCreateToken(file);
  assert.match(t, /^hai_[\w-]{40,}$/);
  assert.equal(loadOrCreateToken(file), t);
  const auth = createAuth({ adminToken: t });
  const id = auth.identify(`Bearer ${t}`);
  assert.ok(can(id, 'admin') && can(id, 'chat') && can(id, 'read') && can(id, 'logan'));
  assert.equal(auth.identify('Bearer wrong'), null);
  assert.equal(auth.identify(undefined), null);
  assert.throws(() => createAuth({ adminToken: 'short' }), /16/);
});

test('device tokens: scoped, hashed on disk, shown once, revocable', () => {
  const dir = tmp();
  const file = join(dir, 'devices.json');
  const auth = createAuth({ adminToken: 'a'.repeat(32), devicesFile: file, now: () => 1000, newId: () => 'dev-1' });
  const { device, token } = auth.addDevice({ name: 'Logan TV', scopes: ['logan'] });
  assert.equal(device.hash, undefined);
  assert.match(token, /^hd_/);
  assert.ok(!readFileSync(file, 'utf8').includes(token));
  const id = auth.identify(`Bearer ${token}`);
  assert.ok(can(id, 'logan'));
  assert.ok(!can(id, 'chat') && !can(id, 'admin') && !can(id, 'read'));
  assert.equal(auth.listDevices()[0].lastSeen, 1000);
  // Survives a restart.
  const again = createAuth({ adminToken: 'a'.repeat(32), devicesFile: file });
  assert.ok(can(again.identify(`Bearer ${token}`), 'logan'));
  again.removeDevice('dev-1');
  assert.equal(again.identify(`Bearer ${token}`), null);
  assert.throws(() => again.removeDevice('dev-1'), /not found/);
});

test('scope hierarchy: chat includes read; read cannot chat; bad scopes rejected', () => {
  const auth = createAuth({ adminToken: 'b'.repeat(32) });
  const chat = auth.identify(`Bearer ${auth.addDevice({ name: 'phone', scopes: ['chat'] }).token}`);
  assert.ok(can(chat, 'read') && can(chat, 'chat') && !can(chat, 'admin'));
  const read = auth.identify(`Bearer ${auth.addDevice({ name: 'wall display', scopes: ['read'] }).token}`);
  assert.ok(can(read, 'read') && !can(read, 'chat'));
  assert.throws(() => auth.addDevice({ name: 'x', scopes: ['root'] }), /scopes/);
  assert.throws(() => auth.addDevice({ name: ' ', scopes: ['read'] }), /name/);
  assert.throws(() => auth.addDevice({ name: 'x', scopes: [] }), /scopes/);
});

test('a devices file written with a BOM (PowerShell/Notepad) still loads', () => {
  const file = join(tmp(), 'devices.json');
  writeFileSync(file, '\uFEFF[]');
  assert.deepEqual(createAuth({ adminToken: 'c'.repeat(32), devicesFile: file }).listDevices(), []);
});
