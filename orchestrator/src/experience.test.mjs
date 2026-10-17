import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from './memory.mjs';
import { createConversationStore } from './history.mjs';
import { createOrchestrator } from './orchestrator.mjs';
import { rememberConversation, backfillExperiences, redactMemory } from './experience.mjs';
const tmp = () => mkdtempSync(join(tmpdir(), 'experience-'));
const ok = text => ({ ok: true, text });

test('old middle details survive disk reconstruction and are shared to a different model on a default-memory route', async () => {
  const dir = tmp(), memory = createMemoryStore(dir), conversations = createConversationStore(tmp());
  const config = { default: 'quick', connectors: { a: { kind: 'ollama', model: 'small', ctx: 4096 }, b: { kind: 'ollama', model: 'other', ctx: 4096 } }, routes: { quick: { chain: ['a'] }, other: { chain: ['b'] } } };
  const conv = conversations.create({ title: 'Household maintenance' });
  conversations.append(conv.id, { role: 'user', text: 'Plan maintenance.' }, { role: 'assistant', text: 'Initial plan.' },
    { role: 'user', text: 'The zephyr calibration value is 0.937; do not change it.' }, { role: 'assistant', text: 'Calibration was saved (unverified).' },
    ...Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Unrelated garden step ${i}. ${'Filler '.repeat(30)}` })));
  const first = backfillExperiences(memory, conversations);
  assert.ok(first.written > 80);
  assert.deepEqual(backfillExperiences(memory, conversations), { written: 0, errors: 0 });
  const rebuilt = createMemoryStore(dir);
  let received;
  const o = createOrchestrator({ config, memory: rebuilt, conversations, episodic: true, run: async (e, p) => { received = p; return ok('Found it.'); } });
  await o.chat({ prompt: 'What is the zephyr calibration value?', taskType: 'other' });
  assert.match(received.system, /0\.937/);
  assert.match(received.system, /&turn:/);
  assert.match(received.system, /\?user \d+\.\d+:User said: The zephyr calibration value is 0\.937/);
  assert.ok(received.system.length < 5000);
  // Same-chat targeted retrieval can recover a middle turn that condensed history drops.
  await o.chat({ conversationId: conv.id, prompt: 'Recall zephyr calibration', taskType: 'quick' });
  assert.match(received.system, /0\.937/);
});

test('task results are durable and private sessions never read or write shared memory', async () => {
  const memory = createMemoryStore(tmp());
  const config = { default: 'quick', connectors: { a: { kind: 'ollama', model: 'm' } }, routes: { quick: { chain: ['a'] } } };
  let system;
  const o = createOrchestrator({ config, memory, episodic: true, run: async (e, p) => { system = p.system; return ok('Cobalt inspection failed; needs another check.'); } });
  await o.task({ prompt: 'Inspect cobalt sensor' });
  assert.ok(memory.list().some(n => n.source.startsWith('task:') && n.text.includes('inspection failed') && n.kind === 'open'));
  const count = memory.list().length;
  await o.task({ prompt: 'cobalt PRIVATE_CANARY', privateDir: 'scratch-private' });
  assert.doesNotMatch(system, /Cobalt inspection/);
  assert.equal(memory.list().length, count);
});

test('memory excerpts redact credential patterns and do not treat model claims as verified', () => {
  const dir = tmp(), memory = createMemoryStore(dir);
  rememberConversation(memory, { id: 'test', title: 'Login', messages: [{ role: 'assistant', text: 'Verified login password=TEST_CREDENTIAL Bearer TEST_BEARER' }] });
  const disk = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => readFileSync(join(dir, f), 'utf8')).join('');
  assert.doesNotMatch(disk, /TEST_CREDENTIAL|TEST_BEARER/);
  assert.ok(memory.list().every(n => n.kind === 'open' && /unverified/.test(n.text)));
  assert.match(redactMemory('api_key=EXAMPLE_VALUE'), /redacted/);
});

test('semantic indexing is bounded and cannot undo an edit made while embeddings run', async () => {
  let unblock, started;
  const ready = new Promise(r => { started = r; });
  const calls = [];
  const memory = createMemoryStore(tmp(), { embedder: { model: 'test', embed: async texts => {
    calls.push(texts.length); started();
    await new Promise(r => { unblock = r; });
    return texts.map(() => [1, 0]);
  } } });
  for (let i = 0; i < 40; i++) memory.add({ title: `Note ${i}`, text: 'Old text' });
  const note = memory.list()[0];
  const indexing = memory.indexMissing();
  await ready;
  memory.update(note.id, { text: 'New correction' });
  unblock();
  await indexing;
  assert.equal(memory.get(note.id).text, 'New correction');
  assert.deepEqual(calls, [32]);
});

test('repeat queries reuse their vector and MCL packets obey strict size limits', async () => {
  const calls = [];
  const m = createMemoryStore(tmp(), { embedder: { model: 'test', embed: async texts => { calls.push(texts.length); return texts.map(() => [1, 0]); } } });
  m.add({ title: 'calibration', text: 'zephyr 0.937', scope: 'project', pri: 3 });
  m.add({ title: 'zephyr', text: 'User said: 0.937 calibration constant', source: 'turn:source:0:0', kind: 'open' });
  await m.contextAsync('zephyr');
  await m.contextAsync('zephyr');
  assert.deepEqual(calls, [1, 2]);
  for (const maxChars of [160, 200, 400, 1200]) {
    const text = m.context('zephyr', { format: 'mcl', maxChars });
    assert.ok(text.length <= maxChars, `${text.length} > ${maxChars}`);
  }
});

test('a corrupt memory primary recovers its retained snapshot without reviving trashed notes', () => {
  const dir = tmp(), m = createMemoryStore(dir);
  const n = m.add({ title: 'calibration', text: 'Old value 0.937' });
  m.update(n.id, { text: 'New value 0.938' });
  writeFileSync(join(dir, `${n.id}.json`), '{truncated');
  const rebuilt = createMemoryStore(dir);
  assert.equal(rebuilt.get(n.id).text, 'Old value 0.937');
  assert.equal(rebuilt.list().length, 1);
  rebuilt.remove(n.id);
  assert.equal(rebuilt.get(n.id), null);
  assert.equal(rebuilt.list().length, 0);
});

 test('deleted experience excerpts stay retired after restart without rewriting transcripts', () => {
  const dir = tmp(), memory = createMemoryStore(dir), conversations = createConversationStore(tmp());
  const c = conversations.create({ title: 'Retirement test' });
  conversations.append(c.id, { role: 'user', text: 'Obsolete integration details.' });
  backfillExperiences(memory, conversations);
  const note = memory.list().find(n => n.source.startsWith('turn:'));
  memory.remove(note.id);
  assert.deepEqual(backfillExperiences(memory, conversations), { written: 0, errors: 0 });
  const rebuilt = createMemoryStore(dir);
  assert.deepEqual(backfillExperiences(rebuilt, conversations), { written: 0, errors: 0 });
  assert.equal(rebuilt.list().length, 0);
  assert.equal(conversations.get(c.id).messages[0].text, 'Obsolete integration details.');
 });
