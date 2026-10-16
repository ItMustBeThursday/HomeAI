import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from './orchestrator.mjs';
import { createConversationStore } from './history.mjs';

const config = { connectors: { a: { kind: 'claude-cli', model: 'a' }, b: { kind: 'codex-cli', model: 'b' } }, routes: { agent: { chain: ['a', 'b'], agent: true } }, default: 'agent' };
const dir = () => mkdtempSync(join(tmpdir(), 'cont-'));
const user = (text) => ({ role: 'user', text, ts: 1 });

test('corrupt conversation file recovers from retained snapshot', () => {
  const d = dir(); const s = createConversationStore(d);
  const c = s.create({ title: 't' });
  s.append(c.id, user('one')); s.append(c.id, user('two'));
  writeFileSync(join(d, `${c.id}.json`), '{"id":"truncat');
  const got = s.get(c.id);
  assert.equal(got.id, c.id); assert.ok(got.messages.length >= 1);
  assert.ok(existsSync(join(d, `${c.id}.json.corrupt`)));
  assert.equal(s.list().length, 1);
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(d, `${c.id}.json`), 'utf8')));
});

test('streamed text is persisted with bounded writes and survives a restart', () => {
  const d = dir(); let t = 1000; const s = createConversationStore(d, { now: () => t });
  const c = s.create({ title: 't' });
  s.begin(c.id, user('go'), { route: 'agent', prompt: 'go', runId: 'run-12345678' });
  s.progress(c.id, { type: 'delta', text: 'Hello ' });
  t += 3000; s.progress(c.id, { type: 'delta', text: 'world' });
  const s2 = createConversationStore(d, { now: () => t });
  assert.equal(s2.recoverInterrupted(), 1);
  assert.equal(s2.recoverInterrupted(), 0); // repeated restarts add no second marker
  const conv = s2.get(c.id);
  assert.equal(conv.run.status, 'interrupted');
  assert.equal(conv.messages.length, 2);
  assert.equal(conv.messages[1].partial, 'Hello world');
  assert.equal(conv.messages[0].text, 'go');
});

test('repeated request id does not run the model twice and is findable', async () => {
  const d = dir(); const conversations = createConversationStore(d); let calls = 0;
  const o = createOrchestrator({ config, conversations, run: async () => (calls++, { ok: true, text: 'done', inputTokens: 1, outputTokens: 1 }) });
  const first = await o.chat({ prompt: 'work', cwd: 'D:/w', runId: 'run-abcdefgh' });
  const again = await o.chat({ prompt: 'work', cwd: 'D:/w', runId: 'run-abcdefgh' });
  assert.equal(calls, 1); assert.equal(again.duplicate, true);
  assert.equal(again.conversation.id, first.conversation.id);
  assert.equal(conversations.list().length, 1);
  assert.equal(conversations.findByRun('run-abcdefgh').id, first.conversation.id);
  assert.equal(conversations.findByRun('nope'), null);
});

test('connector failure, restart, then another model receives saved request and partial text', async () => {
  const d = dir(); const conversations = createConversationStore(d); const prompts = [];
  const o1 = createOrchestrator({ config, conversations, run: async (e, a) => { a.onEvent?.({ type: 'delta', text: 'partial answer' }); return { ok: false, error: 'boom' }; } });
  const r1 = await o1.chat({ prompt: 'refactor module', cwd: 'D:/w', runId: 'run-11111111' });
  assert.equal(r1.reply.ok, false);
  const id = r1.conversation.id;
  assert.equal(conversations.get(id).run.status, 'interrupted');
  const s2 = createConversationStore(d); // simulated restart
  const o2 = createOrchestrator({ config, conversations: s2, run: async (e, a) => (prompts.push(a.prompt), { ok: true, text: 'resumed', inputTokens: 1, outputTokens: 1 }) });
  const r2 = await o2.chat({ conversationId: id, prompt: 'Please resume', cwd: 'D:/w', connector: 'b', runId: 'run-22222222' });
  assert.equal(r2.reply.ok, true);
  assert.match(prompts[0], /refactor module/);
  const msgs = s2.get(id).messages;
  assert.equal(msgs[0].text, 'refactor module');
  assert.equal(msgs.filter((m) => m.role === 'user').length, 2);
});
