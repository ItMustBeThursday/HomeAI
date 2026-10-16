import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoRouter, isAffirmation, parseVerdict, validateAuto } from './autoroute.mjs';

const base = {
  connectors: { fast: { kind: 'ollama', model: 'f' } },
  routes: { general: { chain: ['fast'] }, vision: { chain: ['fast'] }, agent: { chain: ['fast'], agent: true }, plan: { chain: ['fast'], agent: true, readOnly: true, then: 'agent' } },
  auto: { chat: 'general', act: 'agent', plan: 'plan', check: 'fast' },
};
const router = (reply, config = base) => {
  const calls = [];
  const run = async (entry, opts) => {
    calls.push({ entry, ...opts });
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(opts) : reply;
  };
  return { decide: createAutoRouter({ getConfig: () => config, run }), calls };
};

test('rules decide the obvious cases without calling the model', async () => {
  const { decide, calls } = router({ ok: true, text: 'CHAT' });
  const cases = [
    ['thanks!', 'chat'],
    ['hello there', 'chat'],
    ['open C:\\temp\\a.txt', 'act'],
    ['what is in ./src/main.mjs', 'act'],
    ['git status', 'act'],
    ['please reorganise the workspace folders', 'plan'],
  ];
  for (const [prompt, kind] of cases) {
    const d = await decide({ prompt });
    assert.deepEqual([prompt, d.kind, d.via], [prompt, kind, 'rule']);
  }
  assert.equal(calls.length, 0);
  // A go-ahead keeps acting after an action, but is checked after a plain answer.
  assert.equal((await decide({ prompt: 'yes do it', previous: { kind: 'act', text: 'Shall I delete it?' } })).via, 'rule');
  assert.equal((await decide({ prompt: 'yes do it', previous: { kind: 'chat', text: 'Want me to?' } })).via, 'model');
  assert.match(calls[0].prompt, /Previous assistant message \(chat\): Want me to\?/);
});

test('the model decides the rest; images on a chat answer go to vision', async () => {
  const { decide, calls } = router({ ok: true, text: ' Act.', inputTokens: 40, outputTokens: 1 });
  const d = await decide({ prompt: 'is the backup job still running?' });
  assert.deepEqual([d.kind, d.route, d.via, d.checked, d.inputTokens], ['act', 'agent', 'model', 'fast', 40]);
  assert.deepEqual([calls[0].entry.maxTurns, calls[0].entry.tools], [1, []]);
  const v = await router({ ok: true, text: 'CHAT' }).decide({ prompt: 'what is this?', hasImages: true });
  assert.deepEqual([v.kind, v.route], ['chat', 'vision']);
});

test('no permission means chat; failures, junk and timeouts use the fallback', async () => {
  const { decide, calls } = router({ ok: true, text: 'ACT' });
  assert.deepEqual(await decide({ prompt: 'git status', canAct: false }).then((d) => [d.kind, d.reason]), ['chat', 'this device cannot run commands']);
  assert.equal(calls.length, 0);
  assert.deepEqual(await router({ ok: false, error: 'busy' }).decide({ prompt: 'hmm' }).then((d) => [d.kind, d.via, d.reason]), ['act', 'fallback', 'check failed: busy']);
  assert.equal((await router({ ok: true, text: 'maybe' }).decide({ prompt: 'hmm' })).reason, 'check gave no clear answer');
  assert.equal((await router(new Error('boom')).decide({ prompt: 'hmm' })).reason, 'check failed: boom');
  const chatFallback = { ...base, auto: { ...base.auto, fallback: 'chat', timeoutMs: 20, coldTimeoutMs: 20 } };
  const hang = router((opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason))), chatFallback);
  const t = await hang.decide({ prompt: 'hmm' });
  assert.deepEqual([t.kind, t.reason], ['chat', 'check timed out after 20 ms']);
  // The caller stopping the request cancels instead of falling back.
  const ctrl = new AbortController();
  const p = router((opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))))).decide({ prompt: 'hmm', signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, /Cancelled/);
});

test('with several check models, the one already loaded is used; a cold one gets the longer timeout', async () => {
  const config = {
    ...base,
    connectors: { ...base.connectors, main: { kind: 'ollama', model: 'big' }, haiku: { kind: 'claude-cli', model: 'haiku' } },
    auto: { ...base.auto, check: ['main', 'fast'], timeoutMs: 10, coldTimeoutMs: 1000 },
  };
  const make = (loaded, delay = 0) => {
    const calls = [];
    const run = async (entry) => (calls.push(entry.connector), await new Promise((r) => setTimeout(r, delay)), { ok: true, text: 'CHAT' });
    return { decide: createAutoRouter({ getConfig: () => config, run, loaded }), calls };
  };
  const warmFast = make(async () => new Set(['f']));
  assert.equal((await warmFast.decide({ prompt: 'hmm' })).reason, 'fast said CHAT');
  assert.deepEqual(warmFast.calls, ['fast']);
  // Nothing loaded: the first listed model loads, with the cold timeout (50 ms > 10 ms warm limit but < 1000 ms).
  const cold = make(async () => new Set(), 50);
  assert.equal((await cold.decide({ prompt: 'hmm' })).reason, 'main (loaded) said CHAT');
  // Ollama unreachable for the lookup: same as cold.
  const broken = make(async () => { throw new Error('down'); });
  assert.deepEqual([await broken.decide({ prompt: 'hmm' }).then((d) => d.via), broken.calls], ['model', ['main']]);
  // A hosted connector in the list counts as always ready.
  config.auto.check = ['main', 'haiku'];
  const hosted = make(async () => new Set());
  await hosted.decide({ prompt: 'hmm' });
  assert.deepEqual(hosted.calls, ['haiku']);
});

test('without a plan route, PLAN answers become act and the plan rule is off', async () => {
  const noPlan = { ...base, auto: { chat: 'general', act: 'agent', check: 'fast' } };
  const { decide, calls } = router({ ok: true, text: 'PLAN' }, noPlan);
  assert.equal((await decide({ prompt: 'reorganise the workspace folders' })).kind, 'act');
  assert.doesNotMatch(calls[0].prompt, /PLAN/);
  assert.equal(parseVerdict('plan', false), 'act');
  assert.equal(parseVerdict('nothing', true), null);
});

test('mid-conversation: retries and pasted output after an action stay with the agent', async () => {
  const { decide, calls } = router({ ok: true, text: 'CHAT' });
  const after = { kind: 'act', text: 'Still blocked: helper_unknown_error: setup refresh had errors.' };
  for (const prompt of ['ok try now', 'RuntimeAclFailure : False  AccessDenied : True', 'you should be able to switch models dynamically', 'try again']) {
    const d = await decide({ prompt, previous: after });
    assert.deepEqual([prompt, d.kind, d.via], [prompt, 'act', 'rule']);
  }
  assert.equal(calls.length, 0);
  // A real question after an action is still checked, not forced onto the agent.
  assert.equal((await decide({ prompt: 'why is it still blocked?', previous: after })).via, 'model');
  // Shell and model-switching requests are actions even with no earlier turn.
  assert.equal((await decide({ prompt: 'can you try to write to the shell now plz' })).reason, 'asks to run something');
  assert.equal((await decide({ prompt: 'switch to claude and try again' })).kind, 'act');
  assert.equal((await decide({ prompt: 'ok, you run the codex checkj' })).reason, 'asks it to act');
  assert.equal((await decide({ prompt: 'can you explain what a sandbox is' })).via, 'model');
});

test('mid-conversation: a chat reply that said it could not act hands the next statement to the agent', async () => {
  const { decide, calls } = router({ ok: true, text: 'CHAT' });
  const cant = { kind: 'chat', text: "I can't run the Codex check from this session, so I can't confirm it." };
  const d = await decide({ prompt: 'you misunderstand, we are running it from this orchestrator', previous: cant });
  assert.deepEqual([d.kind, d.via], ['act', 'rule']);
  assert.equal((await decide({ prompt: 'why?', previous: cant })).via, 'model');
  // A plain chat answer that did not refuse is still checked by the model.
  assert.equal((await decide({ prompt: 'and what about tomorrow?', previous: { kind: 'chat', text: 'Sure, it is sunny.' } })).via, 'model');
  assert.equal(calls.length, 2);
});

test('affirmations', () => {
  for (const s of ['yes', 'Yes please', 'go ahead', 'ok, do it', 'Approved.', 'sounds good!', 'yes, go ahead']) assert.ok(isAffirmation(s), s);
  for (const s of ['yes but rename it first', 'no', 'go ahead and delete everything in C:\\']) assert.ok(!isAffirmation(s), s);
});

test('validateAuto rejects bad config', () => {
  const v = (auto, routes = base.routes) => () => validateAuto(auto, routes, base.connectors);
  assert.doesNotThrow(v(undefined));
  assert.doesNotThrow(v(base.auto));
  assert.throws(v({ ...base.auto, chat: 'agent' }), /chat must be a route that does not run/);
  assert.throws(v({ ...base.auto, act: 'plan' }), /act must be an agent route/);
  assert.throws(v({ ...base.auto, plan: 'agent' }), /plan must name a planning route/);
  assert.throws(v({ ...base.auto, check: 'nope' }), /check must name/);
  assert.throws(v({ ...base.auto, check: [] }), /check must name/);
  assert.throws(v({ ...base.auto, check: ['fast', 'nope'] }), /check must name/);
  assert.doesNotThrow(v({ ...base.auto, check: ['fast'] }));
  assert.throws(v({ ...base.auto, coldTimeoutMs: 0 }), /coldTimeoutMs/);
  assert.throws(v({ ...base.auto, fallback: 'plan' }), /fallback/);
  assert.throws(v({ ...base.auto, act: 'missing' }), /act must name/);
  assert.throws(v(base.auto, { ...base.routes, auto: { chain: ['fast'] } }), /reserved/);
});
