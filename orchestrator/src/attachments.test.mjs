import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentStore, MAX_IMAGES } from './attachments.mjs';

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const store = () => createAttachmentStore(mkdtempSync(join(tmpdir(), 'att-')));

test('saves a real image, dedupes identical content, and serves it back', () => {
  const s = store();
  const [a] = s.saveAll([{ name: 'dot.png', mediaType: 'image/png', data: PNG }]);
  const [b] = s.saveAll([{ name: 'again.png', mediaType: 'image/png', data: PNG }]);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[a-f0-9]{24}\.png$/);
  assert.equal(s.count(), 1);
  assert.deepEqual(readFileSync(a.path), Buffer.from(PNG, 'base64'));
  assert.equal(s.file(a.id).mediaType, 'image/png');
  assert.equal(s.resolve([{ id: a.id, name: 'x', mediaType: 'image/png' }])[0].path, a.path);
});

test('rejects wrong types, fake contents, empty data, oversize and too many', () => {
  const s = store();
  assert.throws(() => s.saveAll([{ mediaType: 'image/svg+xml', data: PNG }]), /unsupported type/);
  assert.throws(() => s.saveAll([{ mediaType: 'image/jpeg', data: PNG }]), /not image\/jpeg/);
  assert.throws(() => s.saveAll([{ mediaType: 'image/png', data: Buffer.from('not an image at all').toString('base64') }]), /not image\/png/);
  assert.throws(() => s.saveAll([{ mediaType: 'image/png', data: '' }]), /base64/);
  assert.throws(() => s.saveAll('x'), /array/);
  assert.throws(() => s.saveAll(Array(MAX_IMAGES + 1).fill({ mediaType: 'image/png', data: PNG })), /At most/);
  assert.deepEqual(s.saveAll(undefined), []);
});

test('ids cannot escape the folder', () => {
  const s = store();
  assert.throws(() => s.file('..\\..\\secret.png'), /Invalid attachment id/);
  assert.throws(() => s.resolve([{ id: '../x.png' }]), /Invalid attachment id/);
  assert.equal(s.file('0123456789abcdef01234567.png'), null);
});
