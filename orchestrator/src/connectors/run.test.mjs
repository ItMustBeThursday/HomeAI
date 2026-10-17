import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRunner } from './run.mjs';

// Fake child process: records the call and replies with canned stdout.
function fakeSpawn(reply, calls) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', null));
    let input = '';
    child.stdin.on('data', (d) => (input += d));
    child.stdin.on('finish', () => {
      calls.push({ cmd, args, input, env: opts.env, cwd: opts.cwd });
      if (reply === null) return; // hang
      child.stdout.end(reply.stdout ?? '');
      child.stderr.end(reply.stderr ?? '');
      setImmediate(() => child.emit('close', reply.code ?? 0));
    });
    return child;
  };
}

test('claude: prompt via stdin, api keys stripped', async () => {
  const calls = [];
  const run = createRunner({ claudeBin: 'claude.exe', cwd: 'C:\\s', baseEnv: { ANTHROPIC_API_KEY: 'k', PATH: 'p' }, spawnImpl: fakeSpawn({ stdout: '{"result":"pong","usage":{"input_tokens":1,"output_tokens":2}}' }, calls) });
  const r = await run({ kind: 'claude-cli', model: 'haiku', maxTurns: 1, tools: [] }, { prompt: 'secret prompt', system: 'sys' });
  assert.equal(r.text, 'pong');
  assert.equal(calls[0].cmd, 'claude.exe');
  assert.equal(calls[0].input, 'secret prompt');
  assert.ok(!calls[0].args.includes('secret prompt'));
  assert.ok(calls[0].args.includes('sys'));
  assert.equal(calls[0].env.ANTHROPIC_API_KEY, undefined);
  assert.equal(calls[0].env.PATH, 'p');
  assert.equal(calls[0].cwd, 'C:\\s');
});

test('codex: runs script under node with system prepended', async () => {
  const calls = [];
  const out = '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}';
  const run = createRunner({ codexScript: 'codex.js', nodeBin: 'node.exe', spawnImpl: fakeSpawn({ stdout: out }, calls) });
  const r = await run({ kind: 'codex-cli', model: 'gpt' }, { prompt: 'p', system: 's' });
  assert.equal(r.text, 'done');
  assert.equal(calls[0].cmd, 'node.exe');
  assert.equal(calls[0].args[0], 'codex.js');
  assert.equal(calls[0].args.at(-1), '-');
  assert.equal(calls[0].input, 's\n\np');
});

test('cli failures carry an error message', async () => {
  const run = createRunner({ spawnImpl: fakeSpawn({ stdout: 'oops', stderr: 'auth failed', code: 1 }, []) });
  await assert.rejects(run({ kind: 'claude-cli', model: 'x' }, { prompt: 'p' }), /not valid JSON.*auth failed/);
  const run2 = createRunner({ codexScript: 'c.js', spawnImpl: fakeSpawn({ stdout: '{"type":"error","message":"quota exceeded"}', code: 1 }, []) });
  const r = await run2({ kind: 'codex-cli', model: 'x' }, { prompt: 'p' });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('cli timeout kills the child', async () => {
  const run = createRunner({ timeoutMs: 20, spawnImpl: fakeSpawn(null, []) });
  await assert.rejects(run({ kind: 'claude-cli', model: 'x' }, { prompt: 'p' }), /timed out/);
});

const enc = new TextEncoder();
// Body as an async iterable of byte chunks, optionally pausing before the first one.
const streamBody = (chunks, delayMs = 0, signal) => ({
  async *[Symbol.asyncIterator]() {
    if (delayMs) await new Promise((res, rej) => { const t = setTimeout(res, delayMs); signal?.addEventListener('abort', () => (clearTimeout(t), rej(signal.reason))); });
    for (const c of chunks) yield enc.encode(c);
  },
});

test('ollama: streams chat, joins split chunks and reports usage', async () => {
  let sent;
  const chunks = ['{"message":{"content":"he"},"done":false}\n{"mess', 'age":{"content":"y"},"done":false}\n', '{"message":{"content":""},"done":true,"prompt_eval_count":4,"eval_count":2}'];
  const fetchImpl = async (url, init) => ((sent = JSON.parse(init.body)), { ok: true, status: 200, body: streamBody(chunks) });
  const r = await createRunner({ fetchImpl })({ kind: 'ollama', model: 'fast' }, { prompt: 'p' });
  assert.deepEqual(r, { text: 'hey', inputTokens: 4, outputTokens: 2, costUsd: 0, ok: true });
  assert.equal(sent.model, 'fast');
  assert.equal(sent.stream, true);
});

test('ollama: HTTP errors, stream errors and early end', async () => {
  const runWith = (res) => createRunner({ fetchImpl: async () => res })({ kind: 'ollama', model: 'x' }, { prompt: 'p' });
  await assert.rejects(runWith({ ok: false, status: 404, json: async () => ({ error: 'model not found' }) }), /404: model not found/);
  await assert.rejects(runWith({ ok: true, body: streamBody(['{"error":"out of memory"}\n']) }), /out of memory/);
  await assert.rejects(runWith({ ok: true, body: streamBody(['{"message":{"content":"x"},"done":false}\n']) }), /ended early/);
});

test('ollama: busy model fails over after the start timeout', async () => {
  const fetchImpl = async (url, init) => ({ ok: true, body: streamBody(['{"done":true}'], 1000, init.signal) });
  const run = createRunner({ fetchImpl, startTimeoutMs: 20 });
  await assert.rejects(run({ kind: 'ollama', model: 'x' }, { prompt: 'p' }), /no output within 20 ms/);
});

test('ollama: a heavyweight can override the cold-load deadline', async () => {
  const fetchImpl = async (url, init) => ({ ok: true, body: streamBody(['{"message":{"content":"ok"},"done":true}'], 80, init.signal) });
  const run = createRunner({ fetchImpl, startTimeoutMs: 10 });
  assert.equal((await run({ kind: 'ollama', model: 'large', startTimeoutMs: 1000 }, { prompt: 'p' })).text, 'ok');
});

test('rejects unknown kinds and missing codex script', async () => {
  const run = createRunner({});
  await assert.rejects(run({ kind: 'gpt', model: 'x' }, { prompt: 'p' }), /Unknown connector kind/);
  await assert.rejects(run({ kind: 'codex-cli', model: 'x' }, { prompt: 'p' }), /codexScript/);
});
