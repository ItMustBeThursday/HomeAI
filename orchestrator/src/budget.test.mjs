import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCtx, windowTokens, historyChars, memoryChars, LOCAL_CTX } from './budget.mjs';
import { buildOllamaRequest } from './connectors/cli.mjs';

test('every local model gets the same explicit window unless its connector overrides it', () => {
  assert.equal(effectiveCtx({ kind: 'ollama' }), LOCAL_CTX);
  assert.equal(effectiveCtx({ kind: 'ollama', ctx: 1000 }), LOCAL_CTX); // too small to be intentional
  assert.equal(effectiveCtx({ kind: 'ollama', ctx: 16384 }), 16384);
  assert.equal(windowTokens({ kind: 'ollama', model: 'a' }), windowTokens({ kind: 'ollama', model: 'b' }));
});

test('the budget used to build the prompt equals the num_ctx actually sent', () => {
  const entry = { kind: 'ollama', model: 'm' };
  const { body } = buildOllamaRequest({ model: 'm', prompt: 'p', ctx: effectiveCtx(entry) });
  assert.equal(body.options.num_ctx, windowTokens(entry));
  assert.equal(historyChars([entry]), Math.floor(body.options.num_ctx * 4 * 0.4));
  const brief = buildOllamaRequest({ model: 'm', prompt: 'p', brief: true, ctx: effectiveCtx(entry) });
  assert.equal(brief.body.options.num_ctx, body.options.num_ctx); // same window => no model reload between calls
  assert.ok(memoryChars([entry]) >= 1200);
});
