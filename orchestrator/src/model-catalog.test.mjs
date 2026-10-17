import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByCategory, modelDescription } from '../web/model-catalog.js';

test('model categories sort predictably, including unknown categories and numeric names', () => {
  const entries = [['z', { category: 'Coding', label: 'Coder 80B' }], ['b', { category: 'Coding', label: 'Coder 4B' }], ['x', {}], ['a', { category: 'General & reasoning' }], ['y', { category: 'Custom' }]];
  const grouped = groupByCategory(entries);
  assert.deepEqual(grouped.map(([cat]) => cat), ['General & reasoning', 'Coding', 'Custom', 'Other']);
  assert.deepEqual(grouped[1][1].map(([id]) => id), ['b', 'z']);
  assert.equal(entries[0][0], 'z');
});
test('model purpose exposes hardware caveats and has an automatic fallback', () => {
  assert.match(modelDescription({ category: 'Coding', note: 'CPU offload; runtime unverified' }), /CPU offload; runtime unverified/);
  assert.match(modelDescription(), /selected route/);
  assert.match(modelDescription({ model: 'test:tag' }), /Other · test:tag/);
});
