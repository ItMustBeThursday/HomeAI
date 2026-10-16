import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaudeArgs, parseClaudeJson, buildCodexArgs, parseCodexJsonl, buildOllamaRequest, parseOllamaResponse, OLLAMA_URL,
} from './cli.mjs';

test('buildClaudeArgs with no tools passes an empty --tools value', () => {
  const args = buildClaudeArgs({ prompt: 'hi "there"', model: 'sonnet', systemPrompt: 'be brief' });
  assert.deepEqual(args, [
    '-p', 'hi "there"', '--output-format', 'json', '--model', 'sonnet', '--system-prompt', 'be brief',
    '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--max-turns', '1',
  ]);
});

test('buildClaudeArgs joins tools and sets turns; omits system prompt when absent', () => {
  const args = buildClaudeArgs({ prompt: 'p', model: 'opus', tools: ['Read', 'Grep'], maxTurns: 3 });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep');
  assert.equal(args.at(-1), '3');
  assert.ok(!args.includes('--system-prompt'));
  assert.throws(() => buildClaudeArgs({ model: 'x' }), /prompt/);
  assert.throws(() => buildClaudeArgs({ prompt: 'p', model: 'x', maxTurns: 0 }), /maxTurns/);
});

test('parseClaudeJson extracts text, usage and cost', () => {
  const out = JSON.stringify({ result: 'done', usage: { input_tokens: 12, output_tokens: 3 }, total_cost_usd: 0.01, is_error: false });
  assert.deepEqual(parseClaudeJson(out), { text: 'done', inputTokens: 12, outputTokens: 3, costUsd: 0.01, ok: true });
  const cached = JSON.stringify({ result: 'r', usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 4 } });
  assert.equal(parseClaudeJson(cached).inputTokens, 1002);
  assert.deepEqual(parseClaudeJson('{"result":"x","is_error":true}'), { text: 'x', inputTokens: 0, outputTokens: 0, costUsd: null, ok: false });
  assert.throws(() => parseClaudeJson('not json'), /JSON/);
});

test('buildCodexArgs', () => {
  assert.deepEqual(buildCodexArgs({ prompt: 'p', model: 'gpt-5' }), ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-m', 'gpt-5', '-s', 'read-only', 'p']);
  assert.deepEqual(buildCodexArgs({ prompt: 'p', model: 'm', sandbox: 'danger-full-access' }), ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-m', 'm', '-s', 'danger-full-access', 'p']);
  assert.throws(() => buildCodexArgs({ prompt: 'p', model: 'm', sandbox: 'bogus' }), /sandbox/);
});

test('stdinPrompt keeps the prompt out of argv', () => {
  const c = buildClaudeArgs({ model: 'haiku', stdinPrompt: true });
  assert.deepEqual(c.slice(0, 2), ['-p', '--output-format']);
  assert.equal(buildCodexArgs({ model: 'm', stdinPrompt: true }).at(-1), '-');
});

test('parseCodexJsonl takes last agent message and last usage, skipping junk', () => {
  const out = [
    '{"type":"thread.started","thread_id":"t"}',
    'warning: not json',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
    '{"type":"turn.completed","usage":{"input_tokens":40,"output_tokens":9}}',
    '',
  ].join('\n');
  assert.deepEqual(parseCodexJsonl(out), { text: 'final', inputTokens: 40, outputTokens: 9, costUsd: null, ok: true });
});

test('parseCodexJsonl handles older msg events and failures', () => {
  const old = '{"msg":{"type":"agent_message","message":"hi"}}\r\n{"msg":{"type":"token_count","usage":{"input_tokens":2,"output_tokens":1}}}';
  assert.deepEqual(parseCodexJsonl(old), { text: 'hi', inputTokens: 2, outputTokens: 1, costUsd: null, ok: true });
  assert.equal(parseCodexJsonl('{"type":"error","message":"quota"}').ok, false);
  assert.equal(parseCodexJsonl('').ok, false);
});

test('buildOllamaRequest', () => {
  assert.deepEqual(buildOllamaRequest({ model: 'homeai-fast:locked', prompt: 'p', system: 's' }), {
    url: OLLAMA_URL,
    body: { model: 'homeai-fast:locked', stream: false, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'p' }] },
  });
  assert.equal(buildOllamaRequest({ model: 'm', prompt: 'p' }).body.messages.length, 1);
  assert.equal(OLLAMA_URL, 'http://127.0.0.1:11435/api/chat');
});

test('parseOllamaResponse', () => {
  assert.deepEqual(parseOllamaResponse({ message: { content: 'ok' }, prompt_eval_count: 7, eval_count: 2 }), { text: 'ok', inputTokens: 7, outputTokens: 2, costUsd: 0, ok: true });
  assert.equal(parseOllamaResponse({ message: { content: '' } }).inputTokens, 0);
  assert.throws(() => parseOllamaResponse({}), /content/);
});

test('ollama brief requests turn thinking off and cap the output', () => {
  const { body } = buildOllamaRequest({ model: 'm', prompt: 'p', brief: true });
  assert.deepEqual([body.think, body.options], [false, { temperature: 0, num_predict: 8 }]);
  assert.equal(buildOllamaRequest({ model: 'm', prompt: 'p' }).body.think, undefined);
});

test('parseClaudeJson reports refused tool calls so the UI can offer access', () => {
  const out = parseClaudeJson(JSON.stringify({ result: 'blocked', is_error: false, permission_denials: [{ tool_name: 'Read', tool_input: { file_path: 'E:\Data\a.txt' } }, { tool_name: 'Bash', tool_input: { command: 'dir E:\Data' } }] }));
  assert.deepEqual(out.denials, [{ tool: 'Read', path: 'E:\Data\a.txt', command: undefined }, { tool: 'Bash', path: undefined, command: 'dir E:\Data' }]);
  assert.equal(parseClaudeJson(JSON.stringify({ result: 'x' })).denials, undefined);
});

test('buildClaudeArgs and buildCodexArgs pass extra folders through', () => {
  const c = buildClaudeArgs({ prompt: 'p', model: 'm', addDirs: ['E:\Data'] });
  assert.deepEqual(c.slice(c.indexOf('--add-dir')), ['--add-dir', 'E:\Data']);
  const x = buildCodexArgs({ prompt: 'p', model: 'm', addDirs: ['E:\Data'] });
  assert.ok(x.join(' ').includes('--add-dir E:\Data'));
});
