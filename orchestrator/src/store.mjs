// Append-only JSONL ledger on disk.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { rotateIfLarge, recentRotated } from './rotate.mjs';
import { dirname } from 'node:path';
import { makeEntry } from './ledger.mjs';

export function createLedgerStore(file, { maxBytes = 5_000_000, now = Date.now } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('Ledger file path is required');
  mkdirSync(dirname(file), { recursive: true });
  return {
    file,
    loadReset() {
      try {
        const value = JSON.parse(readFileSync(file + '.usage-reset.json', 'utf8')).resetAt;
        if (!Number.isFinite(value) || value < 0) throw new Error('Invalid usage reset marker');
        return value;
      } catch (err) { if (err.code === 'ENOENT') return -1; throw err; }
    },
    saveReset(resetAt) {
      const target = file + '.usage-reset.json';
      writeFileSync(target + '.tmp', JSON.stringify({ resetAt }) + '\n');
      renameSync(target + '.tmp', target);
    },
    // Corrupt or partial lines (e.g. after a crash mid-write) are skipped, not fatal.
    // Includes files rotated in the last 48h so same-day budget usage survives a restart right after a roll.
    load() {
      const entries = [];
      for (const f of [...recentRotated(file, 48 * 3_600_000, now()), file]) {
        let raw;
        try {
          raw = readFileSync(f, 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            entries.push(makeEntry(JSON.parse(line)));
          } catch {}
        }
      }
      return entries;
    },
    append(entry) {
      rotateIfLarge(file, maxBytes, now());
      appendFileSync(file, JSON.stringify(entry) + '\n');
    },
  };
}
