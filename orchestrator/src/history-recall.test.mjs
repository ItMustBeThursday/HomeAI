import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from './history.mjs';
import { queryWords } from './squeeze.mjs';

const filler = (n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Chat entry ${i}: ${'Check paths and water plants. '.repeat(10)}` }));

test('a fact stated early in a long chat reaches the prompt when the new request asks about it', () => {
  const m = filler(70);
  m[2] = { role: 'user', text: 'Synthetic test only: the project name is BLUEFIN. Remember it.' };
  const p = buildPrompt(m, 'What project name did I give you earlier? Reply with only the name.', 13_107);
  assert.match(p, /Relevant earlier messages \(exact words\)/);
  assert.match(p, /BLUEFIN/);
  assert.ok(p.length <= 13_107, `prompt ${p.length} exceeds the budget`);
});

test('no recall block when nothing older matches, or when the chat fits whole', () => {
  const m = filler(70);
  assert.doesNotMatch(buildPrompt(m, 'Explain quantum chromodynamics briefly please.', 13_107), /Relevant earlier messages/);
  const short = [{ role: 'user', text: 'the project name is BLUEFIN' }, { role: 'assistant', text: 'ok' }];
  assert.doesNotMatch(buildPrompt(short, 'what is the project name?', 13_107), /Relevant earlier messages/);
});

test('recall stays within the budget for small windows and is skipped under 1000 chars', () => {
  const m = filler(70);
  m[2] = { role: 'user', text: 'the project name is BLUEFIN' };
  assert.ok(buildPrompt(m, 'what was the project name?', 4000).length <= 4000);
  assert.doesNotMatch(buildPrompt(m, 'what was the project name?', 900), /Relevant earlier messages/);
});

test('queryWords drops filler words and duplicates', () => {
  assert.deepEqual(queryWords('What is the project name? The name!'), ['project', 'name']);
});
