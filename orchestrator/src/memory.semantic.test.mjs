import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore, cosine } from './memory.mjs';
import { createOllamaEmbedder } from './embedder.mjs';

let n = 0;
// Fake embedder: one axis per concept, so similarity is predictable.
const AXES = { wifi: [1, 0, 0], password: [0, 1, 0], dog: [0, 0, 1] };
const vec = (text) => {
  const v = [0, 0, 0];
  for (const [w, axis] of Object.entries(AXES)) if (text.toLowerCase().includes(w)) v[AXES[w].indexOf(1)] = 1;
  return v;
};
const fake = (calls = []) => ({
  model: 'fake-embed',
  embed: async (texts) => {
    calls.push(texts.length);
    return texts.map(vec);
  },
});
const make = (opts) => createMemoryStore(mkdtempSync(join(tmpdir(), 'mem-sem-')), { newId: () => `note-${String(++n).padStart(4, '0')}-xx`, ...opts });

test('cosine: identical, orthogonal, empty', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], []), 0);
  assert.equal(cosine(null, [1]), 0);
});

test('contextAsync finds a note by meaning: query shares a concept, not the note wording', async () => {
  const m = make({ embedder: fake() });
  m.add({ title: 'Router login', text: 'Wifi password is on the sticker under the modem' });
  m.add({ title: 'Dog', text: 'The dog needs a walk at 7' });
  // Query has no word in common with the router note except "wifi" (the concept axis), and no overlap with Dog.
  const ctx = await m.contextAsync('what is the wifi key');
  assert.match(ctx, /Router login/);
  assert.doesNotMatch(ctx, /Dog/);
});

test('semantic path does not invent matches: unrelated query returns nothing', async () => {
  const m = make({ embedder: fake() });
  m.add({ title: 'Router login', text: 'The modem sticker has the wifi key' });
  // "password" is on a different concept axis than the note, and no note word overlaps it.
  assert.equal(await m.contextAsync('password'), '');
});

test('vectors are computed lazily, stored in the file, and not returned by the API', async () => {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), 'mem-sem-'));
  const m = createMemoryStore(dir, { newId: () => `note-${String(++n).padStart(4, '0')}-xx`, embedder: fake(calls) });
  const a = m.add({ title: 'Dog', text: 'dog walk' });
  assert.equal(a.vec, undefined, 'add() output has no vector');
  await m.contextAsync('dog');
  assert.ok(calls.length >= 2, 'embedded the query and the note');
  const listed = m.list()[0];
  assert.equal(listed.vec, undefined);
  assert.equal(listed.vmodel, undefined);
  assert.equal(m.get(a.id).vec, undefined);
  const onDisk = JSON.parse(readFileSync(join(dir, `${a.id}.json`), 'utf8'));
  assert.deepEqual(onDisk.vec, [0, 0, 1]);
  assert.equal(onDisk.vmodel, 'fake-embed');
});

test('editing text drops the stale vector so it is recomputed', async () => {
  const calls = [];
  const m = make({ embedder: fake(calls) });
  const a = m.add({ title: 'Dog', text: 'dog walk' });
  await m.contextAsync('dog');
  const before = calls.length;
  m.update(a.id, { text: 'cat feeding' });
  await m.contextAsync('cat');
  assert.ok(calls.length > before + 1, 're-embedded after edit');
});

test('falls back to keyword search when the embedder fails', async () => {
  const m = make({ embedder: { model: 'x', embed: async () => { throw new Error('down'); } } });
  m.add({ title: 'Dog', text: 'the dog needs a walk' });
  const ctx = await m.contextAsync('dog walk');
  assert.match(ctx, /Dog/);
});

test('without an embedder, contextAsync equals context', async () => {
  const m = make();
  m.add({ title: 'Dog', text: 'the dog needs a walk' });
  assert.equal(await m.contextAsync('dog walk'), m.context('dog walk'));
});

test('core notes always appear', async () => {
  const m = make({ embedder: fake() });
  m.add({ title: 'Rule', text: 'Never share data', tags: ['core'] });
  const ctx = await m.contextAsync('something unrelated');
  assert.match(ctx, /Rule/);
});

test('ollama embedder: posts model and input, checks shape', async () => {
  let sent;
  const e = createOllamaEmbedder({
    model: 'homeai-embedding:locked',
    url: 'http://127.0.0.1:11435/api/embed',
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 });
    },
  });
  assert.deepEqual(await e.embed(['hi']), [[0.1, 0.2]]);
  assert.equal(sent.url, 'http://127.0.0.1:11435/api/embed');
  assert.deepEqual(sent.body, { model: 'homeai-embedding:locked', input: ['hi'] });
  const bad = createOllamaEmbedder({ model: 'm', url: 'u', fetchImpl: async () => new Response(JSON.stringify({ embeddings: [] }), { status: 200 }) });
  await assert.rejects(bad.embed(['a']), /wrong shape/);
});
