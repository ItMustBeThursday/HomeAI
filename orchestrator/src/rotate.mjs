// Rolls an append-only log to <name>.YYYYMMDD[-n].<ext> once it passes a size cap. Never deletes anything.
import { statSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { dirname, basename, extname, join } from 'node:path';

const stamp = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

export function rotateIfLarge(file, maxBytes, nowMs = Date.now()) {
  let size;
  try {
    size = statSync(file).size;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (size < maxBytes) return null;
  const ext = extname(file);
  const stem = file.slice(0, file.length - ext.length);
  let target = `${stem}.${stamp(nowMs)}${ext}`;
  for (let n = 1; existsSync(target); n += 1) target = `${stem}.${stamp(nowMs)}-${n}${ext}`;
  renameSync(file, target);
  return target;
}

// Rotated siblings of `file` modified within `maxAgeMs`, oldest first (used to rebuild same-day budget usage after a restart).
export function recentRotated(file, maxAgeMs, nowMs = Date.now()) {
  const ext = extname(file);
  const stem = basename(file, ext);
  const dir = dirname(file);
  const pattern = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{8}(-\\d+)?${ext.replace('.', '\\.')}$`);
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((n) => pattern.test(n))
    .map((n) => join(dir, n))
    .filter((p) => nowMs - statSync(p).mtimeMs <= maxAgeMs)
    .sort();
}
