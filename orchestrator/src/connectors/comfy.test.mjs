import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fillWorkflow, outputFiles, createComfyRunner } from './comfy.mjs';
import { createRunner } from './run.mjs';

const tpl = JSON.stringify({
  4: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['2', 0] } },
  8: { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: 20 } },
});
const wfDir = mkdtempSync(join(tmpdir(), 'wf-'));
import { writeFileSync } from 'node:fs';
writeFileSync(join(wfDir, 'demo.json'), tpl);
const readFile = (p) => readFileSync(p);

test('fillWorkflow replaces whole-value placeholders, keeps types, leaves fixed values alone', () => {
  const g = fillWorkflow(JSON.parse(tpl), { prompt: 'a cat', seed: 42 });
  assert.equal(g[4].inputs.text, 'a cat');
  assert.equal(g[8].inputs.seed, 42);
  assert.equal(g[8].inputs.steps, 20);
  assert.deepEqual(g[4].inputs.clip, ['2', 0]);
});

test('fillWorkflow rejects unknown or missing placeholders', () => {
  assert.throws(() => fillWorkflow({ a: '{{nope}}' }, {}), /Unknown workflow placeholder/);
  assert.throws(() => fillWorkflow({ a: '{{seed}}' }, {}), /has no value/);
});

test('fillWorkflow does not treat partial braces as placeholders', () => {
  assert.equal(fillWorkflow({ a: 'x {{prompt}} y' }, { prompt: 'z' }).a, 'x {{prompt}} y');
});

test('outputFiles collects files from any output list', () => {
  const files = outputFiles({ 9: { images: [{ filename: 'a.png' }] }, 11: { videos: [{ filename: 'b.mp4', subfolder: 'video' }] }, 12: { text: ['no'] } });
  assert.deepEqual(files.map((f) => f.filename), ['a.png', 'b.mp4']);
});

test('comfy runner: submits, polls history, downloads the file', async () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'abcdef12-3456' }), { status: 200 });
    if (url.includes('/history/')) {
      const done = calls.filter((c) => c.url.includes('/history/')).length >= 2;
      return new Response(JSON.stringify(done ? { 'abcdef12-3456': { outputs: { 11: { videos: [{ filename: 'clip.mp4', subfolder: 'video', type: 'output' }] } }, status: { status_str: 'success' } } } : {}), { status: 200 });
    }
    if (url.includes('/view?')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    if (url.endsWith('/free')) return new Response('{}');
    throw new Error('unexpected ' + url);
  };
  const run = createComfyRunner({ baseUrl: 'http://x', workflowDir: wfDir, outDir: out, fetchImpl, pollMs: 1, readFile, makeId: () => 'client', seed: () => 7 });
  const r = await run({ workflow: 'demo.json' }, { prompt: 'a dog', signal: undefined });
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 1);
  assert.match(r.files[0].path, /abcdef12-clip\.mp4$/);
  assert.deepEqual([...readFileSync(r.files[0].path)], [1, 2, 3]);
  const sent = calls[0].body;
  assert.equal(sent.prompt[4].inputs.text, 'a dog');
  assert.equal(sent.prompt[8].inputs.seed, 7);
  assert.equal(readdirSync(out).length, 1);
  assert.deepEqual(calls.at(-1).body, { unload_models: true, free_memory: true });
});

test('comfy runner: reports workflow errors from history', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'p1' }), { status: 200 });
    return new Response(JSON.stringify({ p1: { outputs: {}, status: { status_str: 'error', messages: [['execution_error', { exception_message: 'CUDA out of memory' }]] } } }), { status: 200 });
  };
  const run = createComfyRunner({ workflowDir: wfDir, outDir: tmpdir(), fetchImpl, pollMs: 1, readFile });
  await assert.rejects(run({ workflow: 'demo.json' }, { prompt: 'x' }), /CUDA out of memory/);
});

test('comfy runner: rejects bad workflow names and server rejections', async () => {
  const run = createComfyRunner({ workflowDir: wfDir, outDir: tmpdir(), fetchImpl: async () => new Response('bad graph', { status: 400 }), pollMs: 1, readFile });
  await assert.rejects(run({ workflow: '../x.json' }, { prompt: 'x' }), /Bad workflow name/);
  await assert.rejects(run({ workflow: 'demo.json' }, { prompt: 'x' }), /rejected the workflow \(HTTP 400\)/);
});

test('createRunner dispatches comfyui kind to the comfy runner and refuses agent use', async () => {
  const seen = [];
  const run = createRunner({ comfyRun: async (entry, opts) => { seen.push([entry.model, opts.prompt]); return { ok: true, text: 'f' }; } });
  const r = await run({ kind: 'comfyui', model: 'm' }, { prompt: 'hello' });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [['m', 'hello']]);
  await assert.rejects(createRunner({})({ kind: 'comfyui', model: 'm' }, { prompt: 'x' }), /not configured/);
  await assert.rejects(run({ kind: 'comfyui', model: 'm', agent: true }, { prompt: 'x', cwd: 'D:/x' }), /cannot run agent/);
});

for (const mode of ['error', 'timeout', 'cancel']) {
  test(`comfy runner cleans up its own job and memory on ${mode}`, async () => {
    const calls = [];
    const ctrl = new AbortController();
    const fetchImpl = async (url, init = {}) => {
      calls.push({ path: new URL(url).pathname, body: init.body && JSON.parse(init.body), signal: init.signal });
      if (url.endsWith('/prompt')) {
        if (mode === 'cancel') ctrl.abort();
        return new Response(JSON.stringify({ prompt_id: 'owned-job' }));
      }
      if (url.includes('/history/')) return new Response(JSON.stringify({ 'owned-job': { status: { status_str: 'error' } } }));
      return new Response('{}');
    };
    const run = createComfyRunner({ workflowDir: wfDir, outDir: tmpdir(), fetchImpl, readFile, pollMs: 2, timeoutMs: mode === 'timeout' ? -1 : 1000 });
    await assert.rejects(run({ workflow: 'demo.json' }, { prompt: 'x', signal: ctrl.signal }), /failed|timed out|Cancelled/);
    const cleanup = calls.filter((c) => ['/queue', '/interrupt', '/free'].includes(c.path));
    assert.deepEqual(cleanup.map(({ path, body }) => ({ path, body })), [
      { path: '/queue', body: { delete: ['owned-job'] } },
      { path: '/interrupt', body: { prompt_id: 'owned-job' } },
      { path: '/free', body: { unload_models: true, free_memory: true } },
    ]);
    assert.ok(cleanup.every((c) => !c.signal.aborted));
  });
}
