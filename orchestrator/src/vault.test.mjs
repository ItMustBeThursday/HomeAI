import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, dpapiCodec } from './vault.mjs';

const fake = { protect: async (s) => `enc:${Buffer.from(s).toString('base64')}`, unprotect: async (e) => { if (!e.startsWith('enc:')) throw new Error('bad'); return Buffer.from(e.slice(4), 'base64').toString(); } };
const file = () => join(mkdtempSync(join(tmpdir(), 'vault-')), 'v.json');

test('stores only the encrypted form, survives reload, and removes', async () => {
  const f = file();
  const v = await createVault({ file: f, codec: fake, now: () => 5 });
  await v.set('github', 'ghp_secretvalue', { account: 'adam', via: 'token' });
  assert.equal(v.get('github'), 'ghp_secretvalue');
  assert.ok(!readFileSync(f, 'utf8').includes('ghp_secretvalue'));
  const again = await createVault({ file: f, codec: fake });
  assert.equal(again.get('github'), 'ghp_secretvalue');
  assert.deepEqual(again.meta('github'), { account: 'adam', connectedAt: 5, via: 'token' });
  assert.equal(again.remove('github'), true);
  assert.equal((await createVault({ file: f, codec: fake })).has('github'), false);
});

test('an entry that cannot be decrypted is reported, not fatal', async () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ github: { enc: 'garbage' } }));
  const v = await createVault({ file: f, codec: fake });
  assert.equal(v.has('github'), false);
  assert.equal(v.unreadable('github'), true);
  await v.set('github', 'new');
  assert.equal(v.unreadable('github'), false);
});

test('rejects empty secrets', async () => {
  const v = await createVault({ file: file(), codec: fake });
  await assert.rejects(() => v.set('x', ''), /non-empty/);
});

test('DPAPI codec round-trips on Windows', { skip: process.platform !== 'win32' }, async () => {
  const c = dpapiCodec();
  const enc = await c.protect('hello "quoted" é');
  assert.notEqual(enc, 'hello');
  assert.equal(await c.unprotect(enc), 'hello "quoted" é');
});
