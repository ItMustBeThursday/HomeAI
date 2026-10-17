import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupData } from './backup-data.mjs';

test('verified backups preserve old snapshots and exclude private sessions and scratch', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'homeai-backup-'));
  const root = path.join(base, 'source'), dest = path.join(base, 'backups');
  for (const dir of ['data/private/session', 'data/scratch', 'config']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/private/session/chat.txt'), 'private fixture');
  fs.writeFileSync(path.join(root, 'data/scratch/prompt.txt'), 'scratch fixture');
  fs.writeFileSync(path.join(root, 'data/tasks.jsonl'), 'retained fixture');
  fs.writeFileSync(path.join(root, 'config/routes.json'), '{}');
  const first = backupData(root, dest), second = backupData(root, dest);
  assert.equal(first.files, 2);
  assert.notEqual(first.target, second.target);
  assert.ok(fs.existsSync(first.target));
  assert.ok(!fs.existsSync(path.join(second.target, 'data/private')));
  assert.ok(!fs.existsSync(path.join(second.target, 'data/scratch')));
  const manifest = JSON.parse(fs.readFileSync(path.join(second.target, 'manifest.json')));
  assert.equal(manifest.verified, true);
  for (const entry of manifest.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(second.target, entry.path))).digest('hex'), entry.sha256);
  assert.throws(() => backupData(root, path.join(root, 'backups')), /overlap/);
  assert.throws(() => backupData(root, path.join(base, 'OneDrive', 'backups')), /OneDrive/);
  assert.throws(() => backupData(path.join(base, 'missing'), dest), /No data or config/);
});

test('backup refuses a directory link rather than traversing it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'homeai-backup-link-'));
  const root = path.join(base, 'source'), outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'data/link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => backupData(root, path.join(base, 'backups')), /links/);
});
