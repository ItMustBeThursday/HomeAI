import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskHistory, buildPrompt, createConversationStore } from './history.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'hist-'));

test('task history appends, lists newest first, survives restart and trims', () => {
  const file = join(tmp(), 'tasks.jsonl');
  const h = createTaskHistory(file, { keep: 3 });
  for (let i = 1; i <= 4; i++) h.append({ id: String(i), prompt: 'p' });
  assert.deepEqual(h.list().map((r) => r.id), ['4', '3', '2']);
  appendFileSync(file, '{"broken\n');
  assert.deepEqual(createTaskHistory(file, { keep: 3 }).list(2).map((r) => r.id), ['4', '3']);
});

test('task history clips long prompts', () => {
  const h = createTaskHistory(join(tmp(), 't.jsonl'));
  assert.equal(h.append({ prompt: 'x'.repeat(5000) }).prompt.length, 4001);
});

test('buildPrompt folds recent turns within the limit', () => {
  assert.equal(buildPrompt([], 'hi'), 'hi');
  const msgs = [{ role: 'user', text: 'old '.repeat(100) }, { role: 'assistant', text: 'a1' }, { role: 'assistant', text: '', error: 'x' }];
  const p = buildPrompt(msgs, 'new', 60);
  assert.match(p, /Assistant: a1/);
  assert.doesNotMatch(p, /old/);
  assert.match(p, /User's new message:\nnew$/);
});

test('conversations: archived and trash lists, trash and restore', () => {
  const dir = tmp();
  let t = 0;
  let n = 0;
  const s = createConversationStore(dir, { now: () => ++t, newId: () => `conv-100${++n}` });
  const a = s.create({ title: 'a' });
  const b = s.create({ title: 'b' });
  const c = s.create({ title: 'c' });
  s.append(a.id, { role: 'user', text: 'hello   there' });
  s.archive(a.id);
  s.trash(b.id);
  assert.deepEqual(s.list().map((x) => x.id), [c.id]);
  assert.deepEqual(s.list('archived').map((x) => x.id), [a.id]);
  assert.equal(s.list('archived')[0].preview, 'hello there');
  assert.deepEqual(s.list('trash').map((x) => x.id), [b.id]);
  assert.ok(existsSync(join(dir, 'trash', `${b.id}.json`)));
  s.trash(a.id); // archived -> trash works too
  assert.deepEqual(s.list('trash').map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.equal(s.restore(a.id).title, 'a');
  assert.deepEqual(s.list().map((x) => x.id).sort(), [a.id, c.id].sort());
  assert.throws(() => s.restore(a.id), /not found/);
  assert.throws(() => s.trash('missing-id'), /not found/);
  assert.throws(() => s.list('bogus'), /state must be/);
});

test('conversations: create, append, rename, list, archive', () => {
  const dir = tmp();
  let t = 0;
  let n = 0;
  const s = createConversationStore(dir, { now: () => ++t, newId: () => `conv-000${++n}` });
  const a = s.create({ title: 'first', taskType: 'quick' });
  const b = s.create({ title: 'second' });
  s.append(a.id, { role: 'user', text: 'hi' });
  assert.equal(s.get(a.id).messages.length, 1);
  assert.deepEqual(s.list().map((c) => c.id), [a.id, b.id]);
  s.rename(b.id, 'renamed');
  assert.equal(s.get(b.id).title, 'renamed');
  s.archive(a.id);
  assert.equal(s.get(a.id), null);
  assert.ok(existsSync(join(dir, 'archive', `${a.id}.json`)));
  assert.throws(() => s.get('../../etc'), /Invalid/);
  assert.throws(() => s.append('missing-id', {}), /not found/);
});
