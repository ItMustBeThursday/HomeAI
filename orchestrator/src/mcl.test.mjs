import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mcl from './mcl.mjs';
import { createMemoryStore } from './memory.mjs';

const sample = [
  { scope: 'adam', kind: 'rule', val: 'Never touch the vault; ever $5 a\b\nline2', pri: 3 },
  { scope: 'adam', kind: 'fact', key: 'pc: gpu', val: '7900XT with the orchestrator, the orchestrator again, orchestrator', tags: ['hw'], date: '261016' },
  { scope: 'proj', kind: 'todo', val: 'finish continuity acceptance', refs: ['plan'] },
  { scope: '', kind: 'pref', val: 'prefer local models' },
];

test('serialize/parse round-trips losslessly, plain and alias-packed', () => {
  for (const alias of [false, true]) {
    const text = mcl.serialize(sample, { alias });
    const { records, errors } = mcl.parse(text);
    assert.deepEqual(errors, []);
    assert.deepEqual(records.sort((a, b) => a.val.localeCompare(b.val)), sample.map(mcl.normalize).sort((a, b) => a.val.localeCompare(b.val)));
  }
});

test('alias packing is smaller than plain and JSON', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ scope: 'x', key: `item${i}`, val: 'the orchestrator service restarts through the scheduled orchestrator script' }));
  const s = mcl.stats(many);
  assert.ok(s.packed < s.plain && s.plain < s.json);
  assert.ok(s.ratio < 0.4, `ratio ${s.ratio}`);
});

test('parser is lenient: bad lines are reported, good ones kept; RESUME-style sigils work', () => {
  const { records, errors } = mcl.parse('# comment\n!rule one\nzzz junk\n+verified thing;#t ^2 \'261016\n$bad\n=\n');
  assert.deepEqual(records.map((r) => [r.kind, r.val, r.pri]), [['rule', 'rule one', 0], ['done', 'verified thing', 2]]);
  assert.equal(errors.length, 3);
});

test('merge upserts by scope+key, retires with -, keeps keyless by text', () => {
  const base = mcl.parse('@a\n=pc:old\n=other:keep\n>do x').records;
  const out = mcl.merge(base, mcl.parse('@a\n=pc:new\n-other\n>do x').records);
  assert.deepEqual(out.map((r) => `${r.key}|${r.val}`).sort(), ['pc|new', '|do x']);
});

test('select ranks priority and rules first, then query hits; render respects budget', () => {
  const recs = mcl.parse('@a\n=gpu:7900XT\n!never leak keys\n=core:always;^3\n=tea:green').records;
  const picked = mcl.select(recs, 'which gpu do I have');
  assert.deepEqual(picked.map((r) => r.key || r.val), ['always'.length ? 'core' : '', 'never leak keys', 'gpu'].map((x, i) => (i === 0 ? 'core' : x)));
  const out = mcl.render(picked, { maxChars: 400 });
  assert.match(out, /^# MCL:/);
  assert.match(out, /=gpu:7900XT/);
  const tiny = mcl.render(picked, { maxChars: 160 });
  assert.ok(tiny.length <= 160 + 12);
  assert.match(tiny, /more/);
  assert.equal(mcl.render([], {}), '');
});

test('store: kind/scope/pri persist, MCL context, export and import (upsert + retire)', () => {
  let n = 0;
  const m = createMemoryStore(mkdtempSync(join(tmpdir(), 'mcl-')), { newId: () => `note-${String(++n).padStart(4, '0')}-xx` });
  m.add({ title: 'Vault rule', text: 'Never touch the vault', kind: 'rule', pri: 3, scope: 'adam' });
  m.add({ title: 'gpu', text: '7900XT 20GB', scope: 'adam' });
  assert.ok(m.list()[0].tags.includes('core') || m.list()[1].tags.includes('core'));
  assert.throws(() => m.add({ title: 't', text: 'x', kind: 'bogus' }), /kind/);
  assert.throws(() => m.add({ title: 't', text: 'x', pri: 9 }), /pri/);
  const ctx = m.context('what gpu', { format: 'mcl' });
  assert.match(ctx, /^# MCL:/);
  assert.match(ctx, /!Vault rule:Never touch the vault;\^3/);
  assert.match(ctx, /=gpu:7900XT 20GB/);
  const ex = m.exportMcl();
  assert.ok(ex.text.includes('@adam'));
  const r1 = m.importMcl('@adam\n=gpu:7900XT 20GB, 64GB RAM\n=tea:green\n-Vault rule');
  assert.deepEqual([r1.added, r1.updated, r1.retired], [1, 1, 1]);
  assert.equal(m.list().length, 2);
  assert.ok(m.list().some((x) => x.text.includes('64GB')));
  const r2 = m.importMcl('=tea:green\nbad\n');
  assert.equal(r2.errors.length, 1);
});
