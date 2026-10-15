// Append-only JSONL ledger on disk.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeEntry } from './ledger.mjs';

export function createLedgerStore(file) {
  if (typeof file !== 'string' || !file) throw new Error('Ledger file path is required');
  mkdirSync(dirname(file), { recursive: true });
  return {
    file,
    // Corrupt or partial lines (e.g. after a crash mid-write) are skipped, not fatal.
    load() {
      let raw;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
      const entries = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          entries.push(makeEntry(JSON.parse(line)));
        } catch {}
      }
      return entries;
    },
    append(entry) {
      appendFileSync(file, JSON.stringify(entry) + '\n');
    },
  };
}
