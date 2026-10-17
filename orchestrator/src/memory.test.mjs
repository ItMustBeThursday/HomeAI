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

test('mcl context shrinks long notes to fit more of them, keeps the queried fact, drops duplicates', async () => {
  const m = createMemoryStore(mkdtempSync(join(tmpdir(), 'memfocus-')));
  const names = ['alder','birch','cedar','dogwood','elm','fir','ginkgo','hazel'];
  for (let i = 0; i < 8; i++) m.add({ title: `entry ${i} sprinkler`, text: `${(`Routine ${names[i]} notes about hedges and ${names[(i+3)%8]} paths ${i}. `).repeat(25)} sprinkler code ${i}00 noted for ${names[i]}. ${(`Closing ${names[(i+5)%8]} remarks ${i}. `).repeat(25)}`, tags: ['episode'], source: `turn:c${i}:0:0` });
  m.add({ title: 'dup a', text: 'sprinkler schedule is monday and thursday at six', tags: [], source: 'x:1' });
  m.add({ title: 'dup a', text: 'sprinkler schedule is monday and thursday at six', tags: [], source: 'x:2' });
  const out = m.context('sprinkler schedule', { format: 'mcl', maxChars: 1800, limit: 20 });
  assert.ok(out.length <= 1800);
  assert.equal(out.match(/monday and thursday/g).length, 1);
  assert.ok((out.match(/sprinkler code/g) ?? []).length >= 3, out);
});

test('retrieval preserves corrections, negation and short numeric differences', () => {
  const { m } = store();
  const prefix = 'Zephyr calibration configuration for the workshop sensor current approved operating value';
  for (const [i, text] of [
    `${prefix} is 0.937.`, `${prefix} is 0.941.`,
    `${prefix} is not 0.941.`,
  ].entries()) m.add({ title: 'Zephyr calibration', text, source: `test:${i}` });
  const packet = m.context('zephyr calibration', { format: 'mcl', maxChars: 1800, limit: 6 });
  assert.match(packet, /is 0\.937/);
  assert.match(packet, /is 0\.941/);
  assert.match(packet, /is not 0\.941/);
});

test('duplicate copies cannot consume all retrieval slots before a distinct fact', () => {
  const { m } = store();
  for (let i = 0; i < 12; i++) m.add({ title: 'Zephyr calibration', text: 'Zephyr calibration previous reading 0.937.', source: `test:${i}` });
  m.add({ title: 'Zephyr', text: 'Zephyr current reading 0.941.', source: 'test:current' });
  const packet = m.context('zephyr calibration', { format: 'mcl', maxChars: 1200, limit: 2 });
  assert.equal((packet.match(/previous reading/g) ?? []).length, 1);
  assert.match(packet, /current reading 0\.941/);
});

test('identical values with different fact names remain separate', () => {
  const { m } = store();
  m.add({ title: 'Workshop router address', text: '192.168.1.1' });
  m.add({ title: 'Workshop printer address', text: '192.168.1.1' });
  const packet = m.context('workshop address', { format: 'mcl', maxChars: 1200 });
  assert.match(packet, /router address/);
  assert.match(packet, /printer address/);
});

test('relevance selects excerpts but original turn order places corrections after obsolete statements', () => {
  const { m } = store();
  m.add({ title: 'Zephyr', text: 'Zephyr old value 0.937.', tags: ['episode'], source: 'turn:conv1:2:0' });
  m.add({ title: 'Zephyr', text: 'Zephyr corrected calibration value 0.941.', tags: ['episode'], source: 'turn:conv1:10:0' });
  const packet = m.context('zephyr corrected calibration', { format: 'mcl', maxChars: 1200 });
  assert.ok(packet.indexOf('0.937') < packet.indexOf('0.941'), packet);
  assert.match(packet, /turn:conv1:2:0/);
  assert.match(packet, /turn:conv1:10:0/);
});

import { createMemoryStore as _cms } from './memory.mjs';
import { rememberConversation as _rc } from './experience.mjs';
import { mkdtempSync as _mk } from 'node:fs';
import { tmpdir as _td } from 'node:os';
import { join as _jn } from 'node:path';
import _test from 'node:test';
import _assert from 'node:assert/strict';
_test('episode excerpts are labelled current or superseded for small models', () => {
  const m = _cms(_mk(_jn(_td(), 'mem-cur-')));
  _rc(m, { id: 'c1', title: 'Zephyr', messages: [
    { role: 'user', text: 'Zephyr record, obsolete: constant is 0.937.' },
    { role: 'user', text: 'Zephyr correction, current: constant is 0.941, not 0.937.' }] });
  const out = m.context('Zephyr constant', { format: 'mcl', maxChars: 1200, limit: 10 });
  _assert.match(out, /\[SUPERSEDED, do not use\][^\n]*0\.937/);
  _assert.match(out, /\[CURRENT\][^\n]*0\.941/);
});
