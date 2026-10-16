import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrants, checkFolder } from './grants.mjs';

const always = () => true;
const opts = { blocked: ['C:\\Users\\adam\\OneDrive'], exists: always };

test('checkFolder normalizes and refuses OneDrive and its parents', () => {
  assert.equal(checkFolder('"D:\\Games\\"', opts), 'D:\\Games');
  assert.throws(() => checkFolder('C:\\Users\\adam\\OneDrive\\Docs', opts), /OneDrive/);
  assert.throws(() => checkFolder('C:\\Users\\adam', opts), /contains OneDrive/);
  assert.throws(() => checkFolder('D:\\stuff\\OneDrive - Personal', opts), /OneDrive/);
  assert.throws(() => checkFolder('relative\\dir', opts), /absolute/);
  assert.throws(() => checkFolder('', opts), /non-empty/);
  assert.throws(() => checkFolder('D:\\nope', { ...opts, exists: () => false }), /does not exist/);
});

test('grants persist, dedupe, split read-only from write, and can be removed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grants-'));
  const file = join(dir, 'grants.json');
  const check = (p) => checkFolder(p, opts);
  const g = createGrants({ file, check, newId: (() => { let n = 0; return () => `g${++n}`; })() });
  const a = g.add({ path: 'D:\\Games' });
  g.add({ path: 'd:\\games' }); // same folder, different case
  const b = g.add({ path: 'D:\\Notes', write: false });
  assert.equal(g.list().length, 2);
  assert.deepEqual(g.dirs(), ['D:\\Games']);
  assert.deepEqual(g.dirs({ readOnly: true }), ['D:\\Games', 'D:\\Notes']);
  assert.ok(g.covers('D:\\Games\\sub\\x.txt'));
  assert.ok(!g.covers('D:\\Other'));
  // survives a restart
  const again = createGrants({ file, check });
  assert.equal(again.list().length, 2);
  again.remove(a.id);
  assert.deepEqual(again.dirs({ readOnly: true }), ['D:\\Notes']);
  assert.throws(() => again.remove('missing'), /not found/);
  assert.ok(existsSync(file));
  assert.equal(b.write, false);
});

test('a corrupt grants file is set aside, not fatal', async () => {
  const { writeFileSync, readdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'grants-'));
  const file = join(dir, 'grants.json');
  writeFileSync(file, '{not json');
  const g = createGrants({ file, check: (p) => checkFolder(p, opts) });
  assert.deepEqual(g.list(), []);
  assert.ok(readdirSync(dir).some((n) => n.includes('corrupt')));
});
