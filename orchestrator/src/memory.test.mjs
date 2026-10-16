import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from './memory.mjs';

let n = 0;
const store = (dir = mkdtempSync(join(tmpdir(), 'mem-'))) => ({ dir, m: createMemoryStore(dir, { newId: () => `note-${String(++n).padStart(4, '0')}-xx` }) });

test('add, get, update, list, remove (to trash)', () => {
  const { dir, m } = store();
  const a = m.add({ title: 'Wifi', text: 'The router lives in the hall cupboard', tags: ['Home', 'home'] });
  assert.deepEqual(a.tags, ['home']);
  assert.equal(m.get(a.id).title, 'Wifi');
  const u = m.update(a.id, { text: 'Router is in the garage now' });
  assert.equal(u.text, 'Router is in the garage now');
  assert.equal(u.title, 'Wifi');
  assert.equal(m.list().length, 1);
  m.remove(a.id);
  assert.equal(m.list().length, 0);
  assert.ok(readdirSync(join(dir, 'trash')).includes(`${a.id}.json`));
  assert.throws(() => m.remove(a.id), /not found/);
});

test('validation and id safety', () => {
  const { m } = store();
  assert.throws(() => m.add({ title: '', text: 'x' }), /title/);
  assert.throws(() => m.add({ title: 't', text: ' ' }), /text/);
  assert.throws(() => m.add({ title: 't', text: 'x', tags: 'a' }), /tags/);
  assert.throws(() => m.get('../../etc'), /Invalid memory id/);
});

test('same source updates the note instead of duplicating', () => {
  const { m } = store();
  m.add({ title: 'Goal', text: 'v1', source: 'file:goal' });
  m.add({ title: 'Goal', text: 'v2', source: 'file:goal' });
  assert.equal(m.list().length, 1);
  assert.equal(m.list()[0].text, 'v2');
});

test('search ranks by title and body word matches', () => {
  const { m } = store();
  m.add({ title: 'Logan menus', text: 'Choice menus for the TV and music', tags: ['logan'] });
  m.add({ title: 'Backups', text: 'Nightly backup of the orchestrator data at 3am' });
  assert.equal(m.search('what are the logan tv menus')[0].title, 'Logan menus');
  assert.equal(m.search('backup data')[0].title, 'Backups');
  assert.deepEqual(m.search('zebra'), []);
});

test('context always includes core notes, adds relevant ones, respects tags and size', () => {
  const { m } = store();
  m.add({ title: 'Never touch OneDrive', text: 'Hard exclusion.', tags: ['core'] });
  m.add({ title: 'Logan menus', text: 'Choice menus for the TV', tags: ['logan'] });
  m.add({ title: 'Garden', text: 'Tomatoes need water daily', tags: ['home'] });
  const ctx = m.context('show the logan tv menus');
  assert.match(ctx, /^Things to remember/);
  assert.match(ctx, /OneDrive/);
  assert.match(ctx, /Logan menus/);
  assert.doesNotMatch(ctx, /Garden/);
  const scoped = m.context('tomatoes water garden logan', { tags: ['home'] });
  assert.match(scoped, /OneDrive/);
  assert.match(scoped, /Garden/);
  assert.doesNotMatch(scoped, /Logan menus/);
  assert.equal(m.context('x', { maxChars: 10 }), '');
  assert.equal(store().m.context('anything'), '');
});
