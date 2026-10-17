import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoutes, resolveChain, nextInChain } from './router.mjs';

const config = () => ({
  connectors: {
    fast: { kind: 'ollama', model: 'homeai-fast:locked' },
    claude: { kind: 'claude-cli', model: 'sonnet' },
    codex: { kind: 'codex-cli', model: 'gpt-5' },
  },
  routes: {
    quick: { chain: ['fast'] },
    coding: { chain: ['codex', 'claude', 'fast'], maxTurns: 4, tools: ['Read'] },
  },
  default: 'quick',
});

test('validateRoutes returns a valid config', () => {
  const c = config();
  assert.equal(validateRoutes(c), c);
});

test('Ollama cold-load overrides are bounded and passed to routes', () => {
  const c = config();
  c.connectors.fast.startTimeoutMs = 240000;
  assert.equal(resolveChain(validateRoutes(c), 'quick')[0].startTimeoutMs, 240000);
  for (const value of [0, -1, 300001, '240000']) {
    c.connectors.fast.startTimeoutMs = value;
    assert.throws(() => validateRoutes(c), /startTimeoutMs/);
  }
  delete c.connectors.fast.startTimeoutMs;
  c.connectors.claude.startTimeoutMs = 240000;
  assert.throws(() => validateRoutes(c), /startTimeoutMs/);
});

test('validateRoutes rejects bad shapes', () => {
  const cases = [
    [null, /object/],
    [{ ...config(), connectors: {} }, /connectors/],
    [{ ...config(), connectors: { x: { kind: 'gpt', model: 'm' } } }, /unknown kind/],
    [{ ...config(), connectors: { x: { kind: 'ollama' } } }, /model/],
    [{ ...config(), routes: {} }, /routes/],
    [{ ...config(), routes: { quick: { chain: [] } } }, /non-empty chain/],
    [{ ...config(), routes: { quick: { chain: ['nope'] } } }, /unknown connector "nope"/],
    [{ ...config(), routes: { quick: { chain: ['fast'], maxTurns: 0 } } }, /maxTurns/],
    [{ ...config(), routes: { quick: { chain: ['fast'], tools: [1] } } }, /tools/],
    [{ ...config(), default: 'missing' }, /default/],
    [{ ...config(), default: 'toString' }, /default/],
  ];
  for (const [c, re] of cases) assert.throws(() => validateRoutes(c), re);
});

test('resolveChain expands connectors with defaults', () => {
  assert.deepEqual(resolveChain(config(), 'quick'), [
    { connector: 'fast', kind: 'ollama', model: 'homeai-fast:locked', maxTurns: 1, tools: [] },
  ]);
  const chain = resolveChain(config(), 'coding');
  assert.deepEqual(chain.map((e) => e.connector), ['codex', 'claude', 'fast']);
  assert.equal(chain[1].maxTurns, 4);
  assert.deepEqual(chain[2].tools, ['Read']);
});

test('resolveChain falls back to default route', () => {
  assert.equal(resolveChain(config(), 'unknown')[0].connector, 'fast');
  assert.equal(resolveChain(config(), 'constructor')[0].connector, 'fast');
});

test('nextInChain walks then ends', () => {
  const chain = resolveChain(config(), 'coding');
  assert.equal(nextInChain(chain, 0).connector, 'claude');
  assert.equal(nextInChain(chain, 1).connector, 'fast');
  assert.equal(nextInChain(chain, 2), null);
  assert.throws(() => nextInChain(chain, -1), /failedIndex/);
  assert.throws(() => nextInChain('x', 0), /array/);
});
