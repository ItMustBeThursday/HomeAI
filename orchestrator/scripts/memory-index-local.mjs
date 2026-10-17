// Complete the shared semantic index locally. Run after local-model generation is idle.
// Existing store guards prevent an embedding from overwriting a concurrent text edit.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory.mjs';
import { createOllamaEmbedder } from '../src/embedder.mjs';

const dir = 'D:/HomeAI/projects/orchestrator/data/memory';
const model = 'homeai-embedding:locked';
const reportFile = `D:/HomeAI/evaluations/memory-index-${Date.now()}.json`;
const coverage = () => {
  let total = 0, indexed = 0, unreadable = 0;
  for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    try {
      const n = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      total++;
      if (n.vmodel === model && Array.isArray(n.vec) && n.vec.length && n.vec.every(Number.isFinite)) indexed++;
    } catch { unreadable++; }
  }
  return { total, indexed, missing: total - indexed, unreadable };
};
const report = { startedAt: new Date().toISOString(), model, before: coverage(), batches: 0, written: 0 };
const memory = createMemoryStore(dir, { embedder: createOllamaEmbedder({ model, url: 'http://127.0.0.1:11435/api/embed', timeoutMs: 120000 }) });
try {
  for (let batch = 0; batch < 100; batch++) {
    const written = await memory.indexMissing();
    report.batches++;
    report.written += written;
    report.after = coverage();
    writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ batch: report.batches, written, ...report.after }));
    if (!report.after.missing || !written) break;
  }
  report.ok = report.after?.missing === 0 && report.after?.unreadable === 0;
} catch (err) {
  // The embedder only returns status/shape validation errors, never input text or credentials.
  report.ok = false;
  report.error = err.message;
}
report.finishedAt = new Date().toISOString();
writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ reportFile, ok: report.ok, before: report.before, after: report.after }));
if (!report.ok) process.exitCode = 1;
