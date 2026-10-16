import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from './orchestrator.mjs';
import { createConversationStore } from './history.mjs';
import { createMemoryStore } from './memory.mjs';

const config = {
  connectors: {
    text: { kind: 'ollama', model: 'text-model' },
    eyes: { kind: 'ollama', model: 'vision-model', vision: true },
    cloud: { kind: 'claude-cli', model: 'sonnet' },
  },
  routes: {
    general: { chain: ['text', 'cloud'], memory: true },
    plain: { chain: ['text'] },
    vision: { chain: ['text', 'eyes', 'cloud'] },
    agent: { chain: ['cloud', 'text'], agent: true, tools: ['Bash'], maxTurns: 9 },
  },
  default: 'general',
};
const ok = (text) => ({ ok: true, text, inputTokens: 1, outputTokens: 1, costUsd: 0 });

test('events carry the connector; a failed attempt is announced before the fallback', async () => {
  const events = [];
  const o = createOrchestrator({
    config,
    run: async (e, { onEvent }) => {
      if (e.connector === 'text') {
        onEvent?.({ type: 'delta', text: 'partial' });
        throw new Error('boom');
      }
      onEvent?.({ type: 'delta', text: 'whole' });
      return ok('whole');
    },
  });
  const r = await o.task({ prompt: 'p', onEvent: (e) => events.push(e) });
  assert.equal(r.connector, 'cloud');
  assert.deepEqual(events.map((e) => `${e.type}:${e.connector}`), ['attempt:text', 'delta:text', 'attempt-failed:text', 'attempt:cloud', 'delta:cloud']);
});

test('cancelling stops the chain, is recorded, and does not try the next connector', async () => {
  const ctrl = new AbortController();
  const tried = [];
  const o = createOrchestrator({
    config,
    run: async (e, { signal }) => {
      tried.push(e.connector);
      ctrl.abort();
      if (signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      return ok('x');
    },
  });
  const r = await o.task({ prompt: 'p', signal: ctrl.signal });
  assert.equal(r.ok, false);
  assert.equal(r.cancelled, true);
  assert.equal(r.error, 'Cancelled');
  assert.deepEqual(tried, ['text']);
  assert.equal(o.usage(0).total.calls, 1);
  // Aborted before starting: nothing runs at all.
  const pre = new AbortController();
  pre.abort();
  const r2 = await o.task({ prompt: 'p', signal: pre.signal });
  assert.equal(r2.cancelled, true);
  assert.deepEqual(tried, ['text']);
});

test('images pick the vision route by default, skip text-only models, and reach the runner', async () => {
  const seen = [];
  const o = createOrchestrator({ config, run: async (e, p) => (seen.push([e.connector, p.images.length]), ok('a red square')) });
  const img = [{ id: 'a.png', name: 'a', mediaType: 'image/png', path: 'C:\\a.png' }];
  const r = await o.task({ prompt: 'what is this', images: img });
  assert.equal(r.taskType, 'vision');
  assert.equal(r.connector, 'eyes');
  assert.deepEqual(seen, [['eyes', 1]]);
  assert.equal(r.attempts[0].skipped, 'cannot read images');
  // An explicit non-vision route with text-only connectors fails cleanly instead of sending an image to a text model.
  const r2 = await o.task({ taskType: 'plain', prompt: 'p', images: img });
  assert.equal(r2.ok, false);
  assert.equal(r2.attempts[0].skipped, 'cannot read images');
});

test('agent routes need a project and add the agent rules; other routes refuse a project', async () => {
  const calls = [];
  const o = createOrchestrator({ config, run: async (e, p) => (calls.push({ e, p }), ok('done')) });
  await assert.rejects(o.task({ taskType: 'agent', prompt: 'p' }), /needs a project/);
  await assert.rejects(o.task({ taskType: 'plain', prompt: 'p', cwd: 'D:\\x' }), /not an agent route/);
  const r = await o.task({ taskType: 'agent', prompt: 'run the tests', cwd: 'D:\\proj', system: 'extra' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].e.agent, true);
  assert.equal(calls[0].e.maxTurns, 9);
  assert.equal(calls[0].p.cwd, 'D:\\proj');
  assert.match(calls[0].p.system, /OneDrive/);
  assert.match(calls[0].p.system, /extra$/);
  // A pinned connector keeps agent mode.
  await o.task({ taskType: 'agent', prompt: 'p', cwd: 'D:\\proj', connector: 'text' });
  assert.equal(calls[1].e.agent, true);
  assert.equal(o.isAgentRoute('agent'), true);
  assert.equal(o.isAgentRoute('plain'), false);
  assert.equal(o.isAgentRoute('does-not-exist'), false);
});

test('routes that opt into memory get matching notes in the system prompt; others do not', async () => {
  const memory = createMemoryStore(mkdtempSync(join(tmpdir(), 'mem-')));
  memory.add({ title: 'Never touch OneDrive', text: 'Hard exclusion.', tags: ['core'] });
  memory.add({ title: 'Router', text: 'The wifi router is in the garage', tags: [] });
  const systems = [];
  const o = createOrchestrator({ config, memory, run: async (e, p) => (systems.push(p.system), ok('x')) });
  await o.task({ taskType: 'general', prompt: 'where is the wifi router', system: 'base' });
  assert.match(systems[0], /^base\n\nThings to remember/);
  assert.match(systems[0], /garage/);
  assert.match(systems[0], /OneDrive/);
  await o.task({ taskType: 'plain', prompt: 'where is the wifi router', system: 'base' });
  assert.equal(systems[1], 'base');
});

test('chat stores image references and the project, and tells later turns an image was attached', async () => {
  const conversations = createConversationStore(mkdtempSync(join(tmpdir(), 'conv-')));
  const prompts = [];
  const o = createOrchestrator({ config, conversations, run: async (e, p) => (prompts.push(p.prompt), ok('seen')) });
  const img = [{ id: 'a.png', name: 'a', mediaType: 'image/png', path: 'C:\\a.png' }];
  const first = await o.chat({ prompt: 'look at this', images: img });
  const conv = conversations.get(first.conversation.id);
  assert.deepEqual(conv.messages[0].images, [{ id: 'a.png', name: 'a', mediaType: 'image/png' }]);
  assert.equal(conv.messages[0].images[0].path, undefined);
  await o.chat({ conversationId: conv.id, prompt: 'and now?' });
  assert.match(prompts[1], /\[attached 1 image\(s\)\]/);
  const agentChat = await o.chat({ prompt: 'fix it', taskType: 'agent', cwd: 'D:\\proj', project: 'orchestrator' });
  assert.equal(conversations.get(agentChat.conversation.id).project, 'orchestrator');
  assert.equal(agentChat.conversation.project, 'orchestrator');
});

test('plan routes: validation of readOnly/then', () => {
  const base = (routes) => ({ connectors: config.connectors, routes: { general: { chain: ['text'] }, ...routes }, default: 'general' });
  assert.throws(() => createOrchestrator({ config: base({ p: { chain: ['cloud'], readOnly: true } }), run: async () => ok('x') }), /only applies to agent/);
  assert.throws(() => createOrchestrator({ config: base({ p: { chain: ['cloud'], agent: true, readOnly: true, then: 'general' } }), run: async () => ok('x') }), /then must name an agent route/);
  assert.throws(() => createOrchestrator({ config: base({ a: { chain: ['cloud'], agent: true }, p: { chain: ['cloud'], agent: true, then: 'a' } }), run: async () => ok('x') }), /then only applies/);
});

test('plan, then approve: the plan runs read-only, approval runs it on the then route with the plan in full', async () => {
  const cfg = { ...config, routes: { ...config.routes, plan: { chain: ['cloud'], agent: true, readOnly: true, then: 'agent', tools: ['Read'] } } };
  const conversations = createConversationStore(mkdtempSync(join(tmpdir(), 'conv-')));
  const calls = [];
  const replies = ['1. move a to b', 'done'];
  const o = createOrchestrator({ config: cfg, conversations, run: async (e, p) => (calls.push({ e, p }), ok(replies.shift())) });
  const first = await o.chat({ prompt: 'tidy the folder', taskType: 'plan', cwd: 'D:\\proj', project: 'proj' });
  assert.equal(calls[0].e.readOnly, true);
  assert.match(calls[0].p.system, /Change nothing/);
  const id = first.conversation.id;
  assert.equal(conversations.get(id).messages[1].plan, true);
  assert.deepEqual(o.approvalFor(id), { route: 'agent', project: 'proj' });

  const r = await o.chat({ conversationId: id, approve: true, prompt: 'skip the docs folder', cwd: 'D:\\proj', project: 'proj' });
  assert.equal(r.reply.taskType, 'agent');
  assert.equal(calls[1].e.readOnly, undefined);
  assert.match(calls[1].p.system, /coding and operations agent/);
  assert.match(calls[1].p.prompt, /approved the plan[\s\S]*skip the docs folder[\s\S]*Approved plan:\n1\. move a to b/);
  const msgs = conversations.get(id).messages;
  assert.equal(msgs[2].approved, true);
  assert.equal(msgs[2].text, 'Approved — run the plan.\nskip the docs folder');
  assert.equal(msgs[3].plan, undefined);
  // Once carried out, there is nothing left to approve.
  assert.equal(o.approvalFor(id), null);
  await assert.rejects(o.chat({ conversationId: id, approve: true, cwd: 'D:\\proj' }), /no plan waiting/);
});

test('a failed approval run leaves the plan approvable; a normal reply after it does not', async () => {
  const cfg = { ...config, routes: { ...config.routes, plan: { chain: ['cloud'], agent: true, readOnly: true, then: 'agent' } } };
  const conversations = createConversationStore(mkdtempSync(join(tmpdir(), 'conv-')));
  let fail = false;
  const o = createOrchestrator({ config: cfg, conversations, run: async () => (fail ? { ok: false, error: 'boom' } : ok('the plan')) });
  const { conversation: { id } } = await o.chat({ prompt: 'p', taskType: 'plan', cwd: 'D:\\proj', project: 'proj' });
  fail = true;
  const r = await o.chat({ conversationId: id, approve: true, cwd: 'D:\\proj' });
  assert.equal(r.reply.ok, false);
  assert.deepEqual(o.approvalFor(id), { route: 'agent', project: 'proj' });
  fail = false;
  await o.chat({ conversationId: id, prompt: 'actually, never mind', taskType: 'general' });
  assert.equal(o.approvalFor(id), null);
});

test('conversation notes reach the model on later turns; extra folders reach agent runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notes-'));
  const conversations = createConversationStore(dir);
  const calls = [];
  const o = createOrchestrator({
    config,
    conversations,
    dirsFor: ({ readOnly }) => (readOnly ? ['R:\ro'] : ['W:\rw']),
    run: async (e, opts) => (calls.push(opts), ok('reply')),
  });
  const first = await o.chat({ prompt: 'hello', taskType: 'plain' });
  const id = first.conversation.id;
  conversations.addNote(id, 'always answer in French');
  await o.chat({ conversationId: id, prompt: 'again', taskType: 'plain' });
  assert.doesNotMatch(calls[0].system ?? '', /French/);
  assert.match(calls[1].system, /always answer in French/);
  assert.throws(() => conversations.addNote(id, ' '), /non-empty/);
  const [n] = conversations.get(id).notes;
  conversations.removeNote(id, n.id);
  assert.equal(conversations.get(id).notes.length, 0);
  await o.task({ taskType: 'agent', prompt: 'do', cwd: 'D:\p', addDirs: ['X:\once'] });
  assert.deepEqual(calls.at(-1).addDirs, ['X:\once', 'W:\rw']);
});
