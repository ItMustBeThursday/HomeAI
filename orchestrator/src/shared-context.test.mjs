import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from './orchestrator.mjs';
import { createConversationStore, buildPrompt } from './history.mjs';
import { createMemoryStore } from './memory.mjs';
import { distill, syncWorkspace, conversationFields, bankRecords } from './distill.mjs';
import { historyChars, memoryChars, windowTokens } from './budget.mjs';
import { buildOllamaRequest } from './connectors/cli.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const ok = (text) => ({ ok: true, text, inputTokens: 1, outputTokens: 1, costUsd: 0 });

const RESUME = `# Handoff
Legend: ! rule
! Never publish without approval. Back up before deletion.
x Wan clips generated; Adam accepted FP8.
o Continuity acceptance remains next.
GOAL build a local orchestrator.
`;

test('distill maps the RESUME legend and caps-prefixed lines to MCL kinds', () => {
  const r = distill('RESUME.md', RESUME);
  const kinds = r.map((x) => x.kind);
  assert.deepEqual(kinds, ['rule', 'rule', 'done', 'open', 'fact']);
  assert.equal(r[0].pri, 3); // approval rule is safety-critical
  assert.equal(r.at(-1).key, 'goal');
  assert.ok(r.every((x) => x.scope === 'project'));
});

test('syncWorkspace is idempotent, follows edits, and skips lines already hand-curated', () => {
  const dir = tmp('ws-');
  const state = join(tmp('st-'), 'state.json');
  writeFileSync(join(dir, 'RESUME.md'), RESUME);
  writeFileSync(join(dir, 'USER.md'), '- Never publish without approval. Back up before deletion.\n- Prefer local models.\n');
  const m = createMemoryStore(tmp('mem-'));
  m.add({ title: 'Local models', text: 'Prefer local models over paid ones', tags: [] });
  const a = syncWorkspace(m, { dir, names: ['RESUME.md', 'USER.md'], stateFile: state });
  assert.equal(a.files, 2);
  // The duplicate sentence in USER.md and the hand-curated preference are not stored twice.
  const texts = m.list().map((n) => n.text.toLowerCase());
  assert.equal(texts.filter((t) => t.includes('never publish')).length, 1);
  assert.equal(texts.filter((t) => t.includes('prefer local models')).length, 1);
  const b = syncWorkspace(m, { dir, names: ['RESUME.md', 'USER.md'], stateFile: state });
  assert.deepEqual([b.files, b.added, b.removed, b.skipped], [0, 0, 0, 2]);
  writeFileSync(join(dir, 'RESUME.md'), RESUME.replace('o Continuity acceptance remains next.', '+ Continuity acceptance passed.'));
  const c = syncWorkspace(m, { dir, names: ['RESUME.md', 'USER.md'], stateFile: state });
  assert.equal(c.removed, 1);
  assert.ok(m.list().some((n) => /passed/.test(n.text) && n.kind === 'done'));
  assert.ok(!m.list().some((n) => /remains next/.test(n.text)));
  // Rendered for a prompt: legend once, keyless records without a duplicated title.
  const ctx = m.context('continuity', { format: 'mcl', maxChars: 2000 });
  assert.match(ctx, /^# MCL:/);
  assert.match(ctx, /\+Continuity acceptance passed/);
});

test('chat stores one experience index without a redundant digest and later chats find it', async () => {
  const conversations = createConversationStore(tmp('conv-'));
  const memory = createMemoryStore(tmp('mem-'));
  const config = { connectors: { t: { kind: 'ollama', model: 'm' } }, routes: { general: { chain: ['t'], memory: true } }, default: 'general' };
  const systems = [];
  const o = createOrchestrator({ config, conversations, memory, episodic: true, run: async (e, p) => (systems.push(p.system), ok('The zebra firmware was flashed with version 7.2 and verified.')) });
  const first = await o.chat({ prompt: 'Please flash the zebra firmware' });
  assert.ok(!memory.list().some(n => n.source.startsWith('conv:')), 'no second digest');
  const note = memory.list().find((n) => n.source.startsWith(`turn:${first.conversation.id}:`) && n.text.includes('zebra firmware was flashed'));
  assert.ok(note, 'experience saved');
  assert.match(note.text, /zebra firmware was flashed/);
  assert.ok(note.tags.includes('chat'));
  // A different conversation sees it; the same conversation does not get its own digest echoed back.
  await o.chat({ prompt: 'what happened with the zebra firmware?' });
  assert.match(systems.at(-1), /zebra firmware was flashed/);
  await o.chat({ conversationId: first.conversation.id, prompt: 'and the zebra firmware again?' });
  assert.doesNotMatch(systems.at(-1), /asked: Please flash/);
  assert.equal(conversationFields({ id: 'x', messages: [{ role: 'user', text: 'hi' }] }), null);
});

test('history budget follows the smallest model window in the route; connector ctx is honoured', () => {
  assert.equal(windowTokens({ kind: 'ollama' }), 8192);
  assert.equal(windowTokens({ kind: 'ollama', ctx: 32768 }), 32768);
  assert.equal(historyChars([{ kind: 'claude-cli' }]), 60_000);
  assert.equal(historyChars([{ kind: 'claude-cli' }, { kind: 'ollama' }]), Math.floor(8192 * 4 * 0.4));
  assert.ok(historyChars([{ kind: 'ollama', ctx: 32768 }]) > historyChars([{ kind: 'ollama' }]));
  assert.ok(memoryChars([{ kind: 'ollama' }]) < memoryChars([{ kind: 'claude-cli' }]));
  assert.equal(historyChars([{ kind: 'comfyui' }]), 12_000);
  assert.deepEqual(buildOllamaRequest({ model: 'm', prompt: 'p', ctx: 32768 }).body.options, { num_ctx: 32768 });
  assert.equal(buildOllamaRequest({ model: 'm', prompt: 'p' }).body.options, undefined);
});

test('a long chat on a small local model keeps the thread within its window', async () => {
  const conversations = createConversationStore(tmp('conv-'));
  const config = { connectors: { t: { kind: 'ollama', model: 'm', ctx: 4096 } }, routes: { general: { chain: ['t'] } }, default: 'general' };
  const prompts = [];
  const o = createOrchestrator({ config, conversations, run: async (e, p) => (prompts.push(p.prompt), ok(`Answer ${prompts.length}: done with item ${prompts.length}, 3 checks passed. ${'Padding text. '.repeat(80)}`)) });
  let id;
  for (let i = 1; i <= 25; i++) id = (await o.chat({ conversationId: id, prompt: `Step ${i}: handle item ${i} in D:/proj/item${i}.mjs` })).conversation.id;
  const last = prompts.at(-1);
  assert.ok(last.length <= 4096 * 4 * 0.4 + 600, `prompt ${last.length}`);
  assert.match(last, /Original request: Step 1:/);
  assert.match(last, /item 20/); // condensed middle turns still visible
});

const BANK_TEXT = `# comment
@rules
!Never touch the vault.;#safety ^3 '261016
@ops
=orc:service on 18850\\; live v0.32.2;#orc ^2
>Pick a model
-gone
`;

test('MEMORY.mcl bank syncs losslessly, follows edits, retires removed lines and trashes legacy prose distills', () => {
  const dir = tmp('bank-');
  const state = join(tmp('st-'), 'state.json');
  writeFileSync(join(dir, 'MEMORY.mcl'), BANK_TEXT);
  const m = createMemoryStore(tmp('mem-'));
  m.add({ title: 'old', text: 'Old prose distill', tags: ['ws'], source: 'ws:RESUME.md:abcdef0123', kind: 'fact', scope: 'project' });
  const a = syncWorkspace(m, { dir, stateFile: state });
  assert.equal(a.added, 3);
  assert.equal(a.removed, 1); // legacy RESUME distill trashed (restorable in memory/trash)
  assert.ok(!m.list().some((n) => n.source === 'ws:RESUME.md:abcdef0123'));
  const rule = m.list().find((n) => n.kind === 'rule');
  assert.equal(rule.scope, 'rules');
  assert.ok(rule.tags.includes('core') && rule.tags.includes('safety'));
  assert.equal(m.list().find((n) => n.title === 'orc').text, 'service on 18850; live v0.32.2');
  const b = syncWorkspace(m, { dir, stateFile: state });
  assert.deepEqual([b.files, b.added, b.removed], [0, 0, 0]);
  writeFileSync(join(dir, 'MEMORY.mcl'), BANK_TEXT.replace('v0.32.2', 'v0.33.0').replace('>Pick a model\n', ''));
  const c = syncWorkspace(m, { dir, stateFile: state });
  assert.equal(c.added, 1);
  assert.equal(c.removed, 2); // edited fact replaced, dropped todo retired
  assert.match(m.list().find((n) => n.title === 'orc').text, /v0\.33\.0/);
  assert.equal(m.list().filter((n) => n.title === 'orc').length, 1);
  assert.equal(bankRecords(BANK_TEXT).records.length, 3);
});

test('bank applies keyed corrections and retirements in source order', () => {
  const { records } = bankRecords('@ops\n=port:100\n=port:200\n=old:obsolete\n-old\n');
  assert.deepEqual(records.map(r => [r.key, r.val]), [['port', '200']]);
});

test('default sync uses only the bank, follows metadata edits and preserves notes on invalid input', () => {
  const dir = tmp('bank-safe-');
  const state = join(tmp('st-'), 'state.json');
  const m = createMemoryStore(tmp('mem-'));
  const path = join(dir, 'MEMORY.mcl');
  writeFileSync(path, '@ops\n=port:200;#before\n');
  writeFileSync(join(dir, 'AGENTS.md'), 'Never use the old port.\n');
  syncWorkspace(m, { dir, stateFile: state });
  assert.equal(m.list().length, 1);
  writeFileSync(path, "@ops\n=port:200;#after '261001 &evidence:verified\n");
  syncWorkspace(m, { dir, stateFile: state });
  assert.ok(m.list()[0].tags.includes('after'));
  assert.ok(!m.list()[0].tags.includes('before'));
  assert.equal(m.list()[0].date, '261001');
  assert.deepEqual(m.list()[0].refs, ['evidence:verified']);
  assert.match(m.exportMcl({ alias: false }).text, /'261001.*&evidence:verified/);
  m.add({ title: 'legacy', text: 'Keep until valid migration', source: 'ws:STATE.md:test' });
  const before = m.list();
  const stateBefore = readFileSync(state, 'utf8');
  for (const invalid of ['', '@ops\n=port:300\nbroken line\n']) {
    writeFileSync(path, invalid);
    assert.throws(() => syncWorkspace(m, { dir, stateFile: state }), /preserved/);
    assert.deepEqual(m.list(), before);
    assert.equal(readFileSync(state, 'utf8'), stateBefore);
  }
  assert.throws(() => syncWorkspace(m, { dir, stateFile: state, readText: () => { throw new Error('unreadable'); } }), /unreadable/);
  assert.deepEqual(m.list(), before);
});
