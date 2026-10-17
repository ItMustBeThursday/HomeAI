// Offline measurement on a copy of the live memory store: how many distinct records fit a budget, before vs after focusing.
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory.mjs';
const src = process.argv[2] ?? 'D:/HomeAI/projects/orchestrator/data/memory';
const dir = mkdtempSync(join(tmpdir(), 'memfit-'));
cpSync(src, dir, { recursive: true });
const m = createMemoryStore(dir);
for (const q of ['usage reset button', 'chat continuity crash recovery', 'wan video cat climb', 'logan switch menu catalog']) {
  const row = { q };
  for (const maxChars of [1200, 2400]) {
    const out = m.context(q, { format: 'mcl', maxChars, limit: 20 });
    row[maxChars] = { chars: out.length, records: (out.match(/^[=!~>+?]/gm) ?? []).length, omitted: +(out.match(/# \+(\d+) more/)?.[1] ?? 0) };
  }
  console.log(JSON.stringify(row));
}
