import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  buildClaudeArgs, buildClaudeStreamInput, createClaudeStreamParser, buildCodexArgs, codexEvents, buildOllamaRequest,
} from './cli.mjs';
import { createRunner } from './run.mjs';

const line = (o) => JSON.stringify(o);
const delta = (text) => line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const result = (text) => line({ type: 'result', result: text, is_error: false, total_cost_usd: 0.001, usage: { input_tokens: 5, output_tokens: 7 } });

test('claude stream args use stream-json; stdin images add input-format; agent adds tools and permission mode', () => {
  const s = buildClaudeArgs({ model: 'm', stdinPrompt: true, stream: true });
  assert.deepEqual(s.slice(0, 7), ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'm']);
  const i = buildClaudeArgs({ model: 'm', streamInput: true });
  assert.ok(i.includes('--input-format') && i.includes('stream-json') && !i.includes('json'));
  const a = buildClaudeArgs({ model: 'm', stdinPrompt: true, stream: true, tools: ['Bash', 'Read'], allowedTools: ['Bash', 'Read'], permissionMode: 'acceptEdits', addDirs: ['D:\\x'] });
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Bash,Read');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(a[a.indexOf('--add-dir') + 1], 'D:\\x');
  // Old behaviour unchanged.
  assert.ok(!buildClaudeArgs({ model: 'm', stdinPrompt: true }).includes('--verbose'));
});

test('claude stream input is one user message with images first', () => {
  const msg = JSON.parse(buildClaudeStreamInput({ prompt: 'what?', images: [{ mediaType: 'image/png', data: 'AAAA' }] }));
  assert.equal(msg.type, 'user');
  assert.deepEqual(msg.message.content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.deepEqual(msg.message.content[1], { type: 'text', text: 'what?' });
});

test('claude stream parser: deltas, spacing between text blocks, tool use, result', () => {
  const p = createClaudeStreamParser();
  assert.deepEqual(p(delta('Hel')), [{ type: 'delta', text: 'Hel' }]);
  assert.deepEqual(p(line({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } })), [{ type: 'delta', text: '\n\n' }]);
  assert.deepEqual(p(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }, { type: 'text', text: 'x' }] } })), [{ type: 'tool', name: 'Bash', summary: 'npm test' }]);
  const r = p(result('done'));
  assert.equal(r[0].type, 'result');
  assert.equal(r[0].text, 'done');
  assert.equal(r[0].inputTokens, 5);
  assert.deepEqual(p('not json'), []);
  assert.deepEqual(p(''), []);
});

test('codex args for images and agent mode; events for messages, commands and edits', () => {
  const a = buildCodexArgs({ model: 'g', stdinPrompt: true, sandbox: 'workspace-write', cwd: 'D:\\p', network: true, images: ['a.png', 'b.png'], addDirs: ['D:\\q'] });
  assert.deepEqual(a, ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-C', 'D:\\p', '--add-dir', 'D:\\q', '-c', 'sandbox_workspace_write.network_access=true', '-i', 'a.png', '-i', 'b.png', '-m', 'g', '-s', 'workspace-write', '-']);
  assert.deepEqual(buildCodexArgs({ model: 'g', stdinPrompt: true }), ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-m', 'g', '-s', 'read-only', '-']);
  assert.deepEqual(codexEvents(line({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } })), [{ type: 'delta', text: 'hi' }]);
  assert.deepEqual(codexEvents(line({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } })), [{ type: 'tool', name: 'shell', summary: 'npm test' }]);
  assert.deepEqual(codexEvents(line({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.js' }, { path: 'b.js' }] } })), [{ type: 'tool', name: 'edit', summary: 'a.js, b.js' }]);
  assert.deepEqual(codexEvents('garbage'), []);
});

test('ollama request carries images on the user message only when given', () => {
  assert.equal(buildOllamaRequest({ model: 'm', prompt: 'p' }).body.messages[0].images, undefined);
  assert.deepEqual(buildOllamaRequest({ model: 'm', prompt: 'p', images: ['QQ=='] }).body.messages[0].images, ['QQ==']);
});

// ---- runner ----
function fakeSpawn(reply, calls) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      calls.killed = true;
      setImmediate(() => child.emit('close', null));
    };
    let input = '';
    child.stdin.on('data', (d) => (input += d));
    child.stdin.on('finish', () => {
      calls.push({ cmd, args, input, cwd: opts.cwd });
      if (reply === null) return; // hang until killed
      child.stdout.end(reply.stdout ?? '');
      child.stderr.end('');
      setImmediate(() => child.emit('close', reply.code ?? 0));
    });
    return child;
  };
}

test('runner streams claude deltas and tool events, and returns the final result', async () => {
  const calls = [];
  const out = [delta('Hi '), delta('there'), line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }] } }), result('Hi there')].join('\n') + '\n';
  const run = createRunner({ claudeBin: 'claude.exe', cwd: 'C:\\s', baseEnv: {}, spawnImpl: fakeSpawn({ stdout: out }, calls) });
  const seen = [];
  const r = await run({ kind: 'claude-cli', model: 'haiku', maxTurns: 1, tools: [] }, { prompt: 'p', onEvent: (e) => seen.push(e) });
  assert.equal(r.text, 'Hi there');
  assert.equal(r.outputTokens, 7);
  assert.deepEqual(seen.map((e) => e.type), ['delta', 'delta', 'tool']);
  assert.ok(calls[0].args.includes('stream-json'));
  assert.equal(calls[0].input, 'p');
  assert.equal(calls[0].cwd, 'C:\\s');
});

test('runner sends claude images as base64 over stdin', async () => {
  const calls = [];
  const run = createRunner({ claudeBin: 'c', baseEnv: {}, spawnImpl: fakeSpawn({ stdout: result('red') + '\n' }, calls), readFile: () => Buffer.from('PNGDATA') });
  const r = await run({ kind: 'claude-cli', model: 'haiku', maxTurns: 1, tools: [] }, { prompt: 'color?', images: [{ path: 'x.png', mediaType: 'image/png' }] });
  assert.equal(r.text, 'red');
  assert.ok(calls[0].args.includes('--input-format'));
  const sent = JSON.parse(calls[0].input);
  assert.equal(sent.message.content[0].source.data, Buffer.from('PNGDATA').toString('base64'));
});

test('agent runs need a working directory, then use project cwd, tools and permission mode', async () => {
  const calls = [];
  const run = createRunner({ claudeBin: 'c', cwd: 'C:\\scratch', baseEnv: {}, spawnImpl: fakeSpawn({ stdout: result('ok') + '\n' }, calls) });
  const entry = { kind: 'claude-cli', model: 'sonnet', maxTurns: 40, tools: ['Bash', 'Read'], agent: true };
  await assert.rejects(run(entry, { prompt: 'p' }), /project/);
  await run(entry, { prompt: 'p', cwd: 'D:\\proj' });
  assert.equal(calls[0].cwd, 'D:\\proj');
  const a = calls[0].args;
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Bash,Read');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(a[a.indexOf('--max-turns') + 1], '40');
});

test('codex agent uses workspace-write in the project; images are passed as paths', async () => {
  const calls = [];
  const out = [line({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } }), line({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }), line({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 4 } })].join('\n');
  const run = createRunner({ codexScript: 'codex.js', nodeBin: 'node.exe', baseEnv: {}, spawnImpl: fakeSpawn({ stdout: out }, calls) });
  const seen = [];
  const r = await run({ kind: 'codex-cli', model: 'g', agent: true }, { prompt: 'p', cwd: 'D:\\proj', images: [{ path: 'img.png' }], onEvent: (e) => seen.push(e) });
  assert.equal(r.text, 'done');
  assert.deepEqual(seen.map((e) => e.type), ['tool', 'delta']);
  const a = calls[0].args;
  assert.equal(a[a.indexOf('-s') + 1], 'danger-full-access');
  assert.equal(a[a.indexOf('-C') + 1], 'D:\\proj');
  assert.equal(a[a.indexOf('-i') + 1], 'img.png');
  assert.equal(calls[0].cwd, 'D:\\proj');
});

test('read-only (planning) agents run in the project but cannot write: no acceptEdits, codex sandbox read-only', async () => {
  const calls = [];
  const claude = createRunner({ claudeBin: 'c', baseEnv: {}, spawnImpl: fakeSpawn({ stdout: result('plan') + '\n' }, calls) });
  await claude({ kind: 'claude-cli', model: 'sonnet', maxTurns: 5, tools: ['Read', 'Glob'], agent: true, readOnly: true }, { prompt: 'p', cwd: 'D:\\proj' });
  assert.equal(calls[0].cwd, 'D:\\proj');
  assert.equal(calls[0].args.includes('--permission-mode'), false);
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], 'Read,Glob');
  const out = line({ type: 'item.completed', item: { type: 'agent_message', text: 'plan' } });
  const codex = createRunner({ codexScript: 'codex.js', nodeBin: 'node.exe', baseEnv: {}, spawnImpl: fakeSpawn({ stdout: out }, calls) });
  await codex({ kind: 'codex-cli', model: 'g', agent: true, readOnly: true }, { prompt: 'p', cwd: 'D:\\proj' });
  const a = calls[1].args;
  assert.equal(a[a.indexOf('-s') + 1], 'read-only');
  assert.equal(a[a.indexOf('-C') + 1], 'D:\\proj');
  assert.equal(a.some((x) => x.includes('network_access')), false);
});

test('ollama: streams deltas, sends images to vision models only', async () => {
  const bodies = [];
  const ndjson = ['{"message":{"content":"a"}}', '{"message":{"content":"b"},"done":true,"prompt_eval_count":2,"eval_count":3}'].join('\n') + '\n';
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, body: [Buffer.from(ndjson)] };
  };
  const run = createRunner({ fetchImpl, readFile: () => Buffer.from('IMG') });
  const deltas = [];
  const r = await run({ kind: 'ollama', model: 'vl', vision: true }, { prompt: 'look', images: [{ path: 'p.png' }], onDelta: (t) => deltas.push(t) });
  assert.equal(r.text, 'ab');
  assert.deepEqual(deltas, ['a', 'b']);
  assert.deepEqual(bodies[0].messages.at(-1).images, [Buffer.from('IMG').toString('base64')]);
  await assert.rejects(run({ kind: 'ollama', model: 'text' }, { prompt: 'look', images: [{ path: 'p.png' }] }), /cannot read images/);
});

test('aborting kills the child and rejects as cancelled', async () => {
  const calls = [];
  const run = createRunner({ claudeBin: 'c', baseEnv: {}, spawnImpl: fakeSpawn(null, calls) });
  const ctrl = new AbortController();
  const p = run({ kind: 'claude-cli', model: 'haiku', maxTurns: 1, tools: [] }, { prompt: 'slow', onDelta: () => {}, signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(p, (err) => err.cancelled === true && /Cancelled/.test(err.message));
  assert.equal(calls.killed, true);
  // Already-aborted signals never start a process.
  const before = calls.length;
  await assert.rejects(run({ kind: 'claude-cli', model: 'haiku', maxTurns: 1, tools: [] }, { prompt: 'x', onDelta: () => {}, signal: ctrl.signal }), /Cancelled/);
  assert.equal(calls.length, before);
});
