import test from 'node:test';
import assert from 'node:assert/strict';
import { systemDirs, createSystemAccess } from './sysaccess.mjs';
import { checkFolder } from './grants.mjs';

const tree = {
  'C:\\': ['Windows', 'Users', 'Recovery', '$Recycle.Bin', 'OneDriveTemp', 'Program Files'],
  'C:\\Users': ['adamc', 'Public'],
  'C:\\Users\\adamc': ['AppData', 'OneDrive - Corp', 'Desktop'],
  'D:\\': ['HoopyFrood'],
};
const blocked = ['C:\\Users\\adamc\\OneDrive - Corp'];
const check = (p) => checkFolder(p, { blocked, exists: () => true });
const listDirs = (p) => tree[p] ?? [];

test('drives holding OneDrive are expanded around it, never granting it', () => {
  const dirs = systemDirs({ drives: ['C:\\', 'D:\\'], listDirs, check });
  assert.ok(dirs.includes('C:\\Windows'));
  assert.ok(dirs.includes('C:\\Program Files'));
  assert.ok(dirs.includes('C:\\Users\\Public'));
  assert.ok(dirs.includes('C:\\Users\\adamc\\AppData'));
  assert.ok(dirs.includes('C:\\Users\\adamc\\Desktop'));
  assert.ok(dirs.includes('D:\\'), 'a clean drive is granted whole');
  assert.ok(!dirs.some((d) => /onedrive/i.test(d)), 'no OneDrive path');
  assert.ok(!dirs.some((d) => /recovery|recycle/i.test(d)), 'system-internal folders skipped');
  assert.ok(!dirs.includes('C:\\') && !dirs.includes('C:\\Users') && !dirs.includes('C:\\Users\\adamc'));
});

test('exclude list and disabled config are honoured', () => {
  const dirs = systemDirs({ drives: ['C:\\'], listDirs, check, skip: ['Windows'] });
  assert.ok(!dirs.includes('C:\\Windows'));
  assert.deepEqual(createSystemAccess({ config: { enabled: false } }).dirs(), []);
});

test('result is cached for the ttl', () => {
  let calls = 0;
  let t = 0;
  const sys = createSystemAccess({ config: { enabled: true }, drives: () => (calls++, ['D:\\']), listDirs, check, now: () => t, ttlMs: 100 });
  sys.dirs(); sys.dirs();
  assert.equal(calls, 1);
  t = 200; sys.dirs();
  assert.equal(calls, 2);
});
