// Saves edited config files atomically, keeping a timestamped backup of the previous version.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function createConfigWriter(backupDir, { keep = 50, now = Date.now } = {}) {
  mkdirSync(backupDir, { recursive: true });
  return function save(file, obj) {
    const name = basename(file, '.json');
    if (existsSync(file)) {
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      copyFileSync(file, join(backupDir, `${name}-${stamp}.json`));
      const old = readdirSync(backupDir).filter((f) => f.startsWith(`${name}-`)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - keep))) unlinkSync(join(backupDir, f));
    }
    writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2) + '\n');
    renameSync(`${file}.tmp`, file);
  };
}
