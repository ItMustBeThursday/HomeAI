import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain, tele, gist, approxTokens } from './squeeze.mjs';

test('plain strips markdown noise and folds code blocks', () => {
  const p = plain('# Title\n**bold** text\n- item\n```js\na\nb\n```\n');
  assert.match(p, /^Title\nbold text\nitem\n\[code 2l\]$/);
});
test('tele drops filler and joins lines', () => {
  assert.equal(tele('Please just back up the files\nand verify'), 'back up files; and verify');
});
test('gist keeps fact-bearing sentences, in order, within the limit', () => {
  const t = 'We chatted about various pleasant things for a while. '.repeat(6) + 'The build failed with error E42 in D:/x/y.mjs. ' + 'More chatter follows here and there. '.repeat(6) + 'Fixed and verified: 261 tests passed.';
  const g = gist(t, 200);
  assert.ok(g.length <= 210);
  assert.match(g, /E42/);
  assert.match(g, /261 tests passed/);
  assert.ok(g.indexOf('E42') < g.indexOf('261'));
});
test('gist returns short text unchanged and approxTokens is sane', () => {
  assert.equal(gist('short one', 100), 'short one');
  assert.equal(approxTokens('x'.repeat(40)), 10);
});

import { focus, dedupe } from './squeeze.mjs';
test('focus keeps the sentence that answers the query, verbatim number included', () => {
  const t = 'Weather chatter goes on. '.repeat(15) + 'The zephyr calibration constant is 0.937. ' + 'More unrelated filler here. '.repeat(15);
  const f = focus(t, ['zephyr', 'calibration', 'constant'], 120);
  assert.ok(f.length <= 130);
  assert.match(f, /0\.937/);
});
test('focus leaves short text alone; dedupe drops near-copies only', () => {
  assert.equal(focus('short text', ['x'], 100), 'short text');
  const k = dedupe(['alpha beta gamma delta epsilon', 'alpha beta gamma delta epsilon', 'totally different words appear here']);
  assert.deepEqual(k, [0, 2]);
});
