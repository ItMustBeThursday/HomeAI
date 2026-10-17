import test from 'node:test'; import assert from 'node:assert/strict';
import { splitMessage, toEntry, ask, isKill } from './bridge.mjs';
import { ChannelSession, formatBatch } from './session.mjs';
const cfg = { channelIds: ['c1'], allowedUserIds: ['u1'], orchestratorUrl: 'http://x', orchestratorToken: 't' };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('splits long text', () => { const p = splitMessage('a '.repeat(2000)); assert.ok(p.every((s) => s.length <= 1900)); assert.ok(p.length > 1); });

test('toEntry filters channel and self, labels owner and bots', () => {
  const m = (o) => ({ author: { id: 'u1', username: 'Adam' }, channelId: 'c1', content: 'hi', mentions: { users: new Map() }, ...o });
  assert.equal(toEntry(m({ channelId: 'c2' }), cfg, 'bot'), null);
  assert.equal(toEntry(m({ author: { id: 'bot' } }), cfg, 'bot'), null);
  assert.equal(toEntry(m({ content: '  ' }), cfg, 'bot'), null);
  assert.ok(toEntry(m({}), cfg, 'bot').isOwner);
  const b = toEntry(m({ author: { id: 'u9', bot: true, username: 'Other' } }), cfg, 'bot');
  assert.ok(b.isBot && !b.isOwner);
  assert.equal(toEntry(m({ content: '<@bot> yo', mentions: { users: new Map([['bot', 1]]) } }), cfg, 'bot').mentionsBot, true);
});

test('ask posts chat with bearer and reads conversation.id', async () => {
  let seen; const r = await ask(cfg, 'yo', undefined, async (u, o) => { seen = [u, o]; return { ok: true, json: async () => ({ reply: { text: 'hey' }, conversation: { id: 'cv' } }) }; });
  assert.equal(r.text, 'hey'); assert.equal(r.conversationId, 'cv'); assert.equal(seen[0], 'http://x/api/chat'); assert.match(seen[1].headers.authorization, /^Bearer t$/);
});

function harness(over = {}) {
  const calls = []; const sent = []; let saved; let release;
  const s = new ChannelSession({
    ask: async (prompt, id) => { calls.push({ prompt, id }); if (over.gate) await new Promise((r) => { release = r; }); return { text: over.reply ?? 'ok', conversationId: 'conv-1' }; },
    send: async (t) => sent.push(t), saveId: (i) => { saved = i; }, quietMs: 20, maxWaitMs: 100, ...over.opts,
  });
  return { s, calls, sent, saved: () => saved, release: () => release() };
}
const owner = (text) => ({ author: 'Adam', text, ts: Date.now(), isOwner: true });
const human = (text) => ({ author: 'Sam', text, ts: Date.now() });
const bot = (text) => ({ author: 'Bot2', text, ts: Date.now(), isBot: true });

test('burst of messages becomes ONE model call and one reply', async () => {
  const h = harness();
  h.s.hear(owner('a')); h.s.hear(owner('b')); h.s.hear(owner('c'));
  await tick(80);
  assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1);
  for (const t of ['a', 'b', 'c']) assert.match(h.calls[0].prompt, new RegExp(`Adam \\(Adam\\): ${t}`));
});

test('messages arriving while busy wait and reuse the same conversation', async () => {
  const h = harness({ gate: true });
  h.s.hear(owner('first')); await tick(40);
  assert.equal(h.calls.length, 1);
  h.s.hear(owner('second')); h.s.hear(owner('third')); await tick(40);
  assert.equal(h.calls.length, 1, 'no parallel call while busy');
  h.release(); await tick(60); h.release(); await tick(30);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].id, 'conv-1'); assert.equal(h.saved(), 'conv-1');
  assert.match(h.calls[1].prompt, /second/); assert.match(h.calls[1].prompt, /third/); assert.doesNotMatch(h.calls[1].prompt, /first/);
});

test('NO_REPLY sends nothing', async () => {
  const h = harness({ reply: 'NO_REPLY' }); h.s.hear(owner('lol')); await tick(60);
  assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 0);
});

test('bot chatter without a human is held as context, then capped by streak', async () => {
  const h = harness({ opts: { openChat: false } });
  h.s.hear(bot('beep')); await tick(60);
  assert.equal(h.calls.length, 0);
  h.s.hear(owner('hello')); await tick(60);
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].prompt, /beep/);
  const g = harness({ opts: { maxBotStreak: 2 } });
  for (let i = 0; i < 4; i++) g.s.hear(bot('thanks ' + i));
  await tick(60); assert.equal(g.calls.length, 0, 'bot-only streak beyond cap does not wake the model');
});

test('error is not spammed to the channel and the batch is kept as context', async () => {
  let n = 0; const sent = [];
  const s = new ChannelSession({ ask: async (p) => { n++; if (n === 1) throw new Error('boom'); return { text: 'ok', conversationId: 'c' }; }, send: async (t) => sent.push(t), quietMs: 10, maxWaitMs: 50 });
  s.hear(owner('one')); await tick(50); assert.equal(sent.length, 0);
  s.hear(owner('two')); await tick(50); assert.equal(sent.length, 1);
});

test('formatBatch labels bots and owner; guidelines only on first turn', () => {
  const t = formatBatch([owner('x'), bot('y')], { full: true });
  assert.match(t, /NO_REPLY/); assert.match(t, /Bot2 \(bot\): y/);
  assert.doesNotMatch(formatBatch([owner('x')], { full: false }), /participant in a shared Discord/);
});

test('kill switch: owner-only, case-insensitive, never a bot', () => {
  const m = (o) => ({ author: { id: 'u1' }, content: 'Vogon Poetry', ...o });
  assert.equal(isKill(m({}), cfg), true);
  assert.equal(isKill(m({ content: 'ok  VOGON\n poetry now' }), cfg), true);
  assert.equal(isKill(m({ author: { id: 'u9' } }), cfg), false);
  assert.equal(isKill(m({ author: { id: 'u1', bot: true } }), cfg), false);
  assert.equal(isKill(m({ content: 'vogon' }), cfg), false);
});

test('halt drops queued work and blocks replies', async () => {
  const sent = []; let asked = 0;
  const s = new ChannelSession({ ask: async () => { asked++; return { text: 'hi', conversationId: 'x' }; }, send: async (t) => sent.push(t), quietMs: 10, maxWaitMs: 20 });
  s.hear({ author: 'Adam', text: 'hello', ts: Date.now(), isOwner: true });
  s.halt(); await tick(60);
  s.hear({ author: 'Adam', text: 'again', ts: Date.now(), isOwner: true }); await tick(60);
  assert.equal(asked, 0); assert.deepEqual(sent, []);
});
