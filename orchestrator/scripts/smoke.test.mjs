import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoke } from './smoke.mjs';

const config = { connectors: { codex: { kind: 'codex-cli', model: 'configured-model' } } };
const output = () => {};
test('smoke uses configured model and runner stdin prompt transport', async () => {
  const calls = [];
  const status = await smoke({ names: ['codex'], config, output, run: async (...args) => {
    calls.push(args);
    return { ok: true, text: 'pong' };
  } });
  assert.equal(status, 0);
  assert.equal(calls[0][0].model, 'configured-model');
  assert.equal(calls[0][0].connector, 'codex');
  assert.deepEqual(calls[0][1], { prompt: 'Reply with exactly: pong' });
});
test('smoke returns failure for connector failure, wrong reply, missing name and thrown error', async () => {
  for (const run of [async () => ({ ok: false, text: '' }), async () => ({ ok: true, text: 'wrong' }), async () => { throw new Error('auth failed'); }]) {
    assert.equal(await smoke({ names: ['codex'], config, run, output }), 1);
  }
  assert.equal(await smoke({ names: ['unknown'], config, run: async () => assert.fail('must not run'), output }), 1);
});
