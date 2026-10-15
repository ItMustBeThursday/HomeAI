import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateIfLarge, recentRotated } from './rotate.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'rot-'));
const day = Date.UTC(2026, 9, 15, 12);

test('does nothing below the cap or when the file is missing', () => {
  const d = dir();
  assert.equal(rotateIfLarge(join(d, 'x.jsonl'), 10, day), null);
  writeFileSync(join(d, 'x.jsonl'), 'abc');
  assert.equal(rotateIfLarge(join(d, 'x.jsonl'), 10, day), null);
  assert.deepEqual(readdirSync(d), ['x.jsonl']);
});

test('rolls to a dated name, keeps content, never overwrites', () => {
  const d = dir();
  const f = join(d, 'ledger.jsonl');
  writeFileSync(f, 'a'.repeat(20));
  assert.equal(rotateIfLarge(f, 10, day), join(d, 'ledger.20261015.jsonl'));
  writeFileSync(f, 'b'.repeat(20));
  assert.equal(rotateIfLarge(f, 10, day), join(d, 'ledger.20261015-1.jsonl'));
  assert.equal(readFileSync(join(d, 'ledger.20261015.jsonl'), 'utf8'), 'a'.repeat(20));
  assert.deepEqual(readdirSync(d).sort(), ['ledger.20261015-1.jsonl', 'ledger.20261015.jsonl']);
});

test('recentRotated finds only matching, recent siblings', () => {
  const d = dir();
  const f = join(d, 'ledger.jsonl');
  writeFileSync(join(d, 'ledger.20261015.jsonl'), '');
  writeFileSync(join(d, 'tasks.20261015.jsonl'), '');
  writeFileSync(join(d, 'ledger.jsonl'), '');
  assert.deepEqual(recentRotated(f, 60_000, Date.now()), [join(d, 'ledger.20261015.jsonl')]);
  assert.deepEqual(recentRotated(f, 60_000, Date.now() + 3_600_000), []);
});
