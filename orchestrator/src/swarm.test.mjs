import test from 'node:test';
import assert from 'node:assert/strict';
import { createSwarm, createPacer } from './swarm.mjs';
import { createHostedClient, HostedError, looksSensitive, redact } from './hosted.mjs';

const P = (id, extra = {}) => ({ id, baseUrl: 'https://x.test/v1', keyEnv: `K_${id}`, rpm: 6000, models: ['m1', 'm2'], ...extra });
const mkLocal = (plan) => async ({ system, prompt }) => ({
  text: system?.startsWith('You split') ? plan : system?.startsWith('Merge') ? 'MERGED' : `L:${prompt.slice(0, 10)}`, inputTokens: 1, outputTokens: 1,
});
const PLAN = JSON.stringify([{ title: 'a', prompt: 'do A' }, { title: 'b', prompt: 'do B' }, { title: 'c', prompt: 'do C' }]);
const fast = () => createPacer({ sleep: async () => {} });

test('fans out across providers and merges locally', async () => {
  const hosted = async (p, m, { prompt }) => ({ text: `H:${prompt}`, inputTokens: 2, outputTokens: 3 });
  const out = await createSwarm({ providers: [P('a'), P('b')], hosted, local: mkLocal(PLAN), pacer: fast() })('big task');
  assert.equal(out.answer, 'MERGED');
  assert.equal(out.parts.length, 3);
  assert.deepEqual(new Set(out.parts.map((p) => p.worker.split('/')[0])), new Set(['a', 'b']));
  assert.equal(out.verified, false);
});

test('429 triggers fallback to next provider, then to local', async () => {
  const hosted = async (p) => { throw p.id === 'a' ? new HostedError('rl', { status: 429, rateLimited: true }) : new HostedError('boom', { status: 500 }); };
  const out = await createSwarm({ providers: [P('a'), P('b')], hosted, local: mkLocal(PLAN), pacer: fast() })('t');
  assert.ok(out.parts.every((p) => p.worker === 'local-fallback'));
  assert.ok(out.parts.some((p) => p.tried.some((t) => t.endsWith(':429'))));
});

test('sensitive task never reaches hosted workers', async () => {
  let called = 0;
  const hosted = async () => { called++; return { text: 'x', inputTokens: 0, outputTokens: 0 }; };
  const out = await createSwarm({ providers: [P('a')], hosted, local: mkLocal(PLAN), pacer: fast() })('use api_key=abcd1234efgh5678 please');
  assert.equal(called, 0);
  assert.equal(out.blockedSensitive, true);
  assert.ok(out.parts.every((p) => p.worker === 'local'));
});

test('no enabled providers => local only; bad plan => single task', async () => {
  const out = await createSwarm({ providers: [P('a', { enabled: false })], hosted: async () => { throw new Error('no'); }, local: mkLocal('not json'), pacer: fast() })('hello world');
  assert.equal(out.planned, false);
  assert.equal(out.hostedUsed, false);
  assert.equal(out.parts.length, 1);
});

test('pacer: spaces calls, enforces daily cap with headroom, honours cooldown', () => {
  let t = 1_000_000;
  const pc = createPacer({ now: () => t });
  const p = { id: 'z', rpm: 60, rpd: 10 };
  assert.equal(pc.reserve(p), 0);
  assert.equal(pc.reserve(p), 1000);
  for (let i = 0; i < 7; i++) { t += 2000; assert.equal(pc.reserve(p), 0); }
  t += 2000;
  assert.equal(pc.reserve(p), null); // 9 used = 90% of 10
  pc.cooldown({ id: 'y' }, 120_000);
  assert.equal(pc.reserve({ id: 'y' }, 30_000), null);
});

test('hosted client: bearer key, parsed reply, key redacted from errors', async () => {
  const key = 'sk-live-SECRETSECRETSECRET1234';
  let req;
  const ok = createHostedClient({ env: { K: key }, fetchImpl: async (u, i) => { req = { u, i }; return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 4, completion_tokens: 5 } })); } });
  const r = await ok({ id: 'p', baseUrl: 'https://x.test/v1/', keyEnv: 'K' }, 'm', { prompt: 'q' });
  assert.equal(r.text, 'hi');
  assert.equal(r.costUsd, 0);
  assert.equal(req.u, 'https://x.test/v1/chat/completions');
  assert.equal(req.i.headers.authorization, `Bearer ${key}`);
  const bad = createHostedClient({ env: { K: key }, fetchImpl: async () => new Response(`bad key ${key}`, { status: 401 }) });
  await assert.rejects(bad({ id: 'p', baseUrl: 'https://x.test/v1', keyEnv: 'K' }, 'm', { prompt: 'q' }), (e) => !e.message.includes(key) && e.status === 401);
  await assert.rejects(createHostedClient({ env: {} })({ id: 'p', baseUrl: 'https://x.test', keyEnv: 'K' }, 'm', { prompt: 'q' }), /not set/);
  await assert.rejects(ok({ id: 'p', baseUrl: 'http://x.test', keyEnv: 'K' }, 'm', { prompt: 'q' }), /https/);
  const rl = createHostedClient({ env: { K: key }, fetchImpl: async () => new Response('slow', { status: 429, headers: { 'retry-after': '7' } }) });
  await assert.rejects(rl({ id: 'p', baseUrl: 'https://x.test', keyEnv: 'K' }, 'm', { prompt: 'q' }), (e) => e.rateLimited && e.retryAfterMs === 7000);
});

test('secret heuristics', () => {
  assert.ok(looksSensitive('token: abcdefgh12345678'));
  assert.ok(looksSensitive(`gsk_${'a'.repeat(30)}`));
  assert.ok(!looksSensitive('Summarise the plot of Hamlet'));
  assert.ok(!redact(`x sk-${'a'.repeat(20)}`, 'k').includes('sk-aaaa'));
});
