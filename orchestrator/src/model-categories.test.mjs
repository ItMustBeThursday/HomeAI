import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRoutes } from './router.mjs';

const live = JSON.parse(readFileSync(new URL('../config/routes.json', import.meta.url), 'utf8'));

test('live routes.json validates and every connector has a category and label', () => {
  validateRoutes(live);
  for (const [name, c] of Object.entries(live.connectors)) {
    assert.ok(c.category, `${name} needs a category`);
    assert.ok(c.label, `${name} needs a label`);
  }
});

test('the active heavyweight additions are registered and routed', () => {
  for (const k of ['local-coder-next', 'local-moe-fast']) {
    assert.equal(live.connectors[k].kind, 'ollama');
    assert.match(live.connectors[k].model, /:locked$/);
  }
  assert.ok(live.routes['coding-local'].chain.includes('local-coder-next'));
});

test('blank category/label/note are rejected', () => {
  const bad = structuredClone(live);
  bad.connectors['local-fast'].category = '  ';
  assert.throws(() => validateRoutes(bad), /category must be a non-empty string/);
});
