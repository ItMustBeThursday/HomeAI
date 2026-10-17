// Local-only: finish aliases as the already running downloader completes.
// No pulls, paid providers, service restarts, or deletion.
import { readFileSync, writeFileSync } from 'node:fs';
const base = 'http://127.0.0.1:11435';
const selected = [
  ['local-moe-fast', 'qwen3.5:35b-a3b-q4_K_M', 'homeai-moe-fast:locked'],
  ['local-coder-next', 'qwen3-coder-next:q4_K_M', 'homeai-coder-next:locked'],
  ['local-giant', 'gpt-oss:120b', 'homeai-giant:locked'],
  ['local-deep', 'qwen3-next:80b-a3b-instruct-q4_K_M', 'homeai-deep:locked'],
  ['local-main', 'qwen3.8:27b-q4_K_M', 'homeai-main:locked'],
];
const evidenceFile = 'D:/HomeAI/evaluations/model-catalog-20261016.json';
let results = [];
try { results = JSON.parse(readFileSync(evidenceFile, 'utf8')); } catch {}
async function request(path, body, ms = 10000) {
  const r = await fetch(base + path, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(ms) });
  const data = await r.json();
  if (!r.ok || data.error) throw Error(data.error || `HTTP ${r.status}`);
  return data;
}
const wait = process.argv.includes('--wait');
const retryFailed = process.argv.includes('--retry-failed');
const deadline = Date.now() + 100 * 60000;
do {
  const { models } = await request('/api/tags');
  for (const [id, source, alias] of selected) {
    const prior = results.find(r => r.source === source);
    if (prior?.smoke && (prior.smoke.ok || !retryFailed)) continue;
    const installed = models.find(m => m.name === source);
    if (!installed) continue;
    const existing = models.find(m => m.name === alias);
    if (existing && existing.digest !== installed.digest) throw Error(`Refusing to replace different alias: ${alias}`);
    if (!existing) await request('/api/copy', { source, destination: alias });
    const show = await request('/api/show', { model: alias });
    const row = { id, source, alias, digest: installed.digest, bytes: installed.size, quantization: show.details?.quantization_level, capabilities: show.capabilities, checkedAt: new Date().toISOString() };
    if (prior?.smoke) row.previousSmoke = [...(prior.previousSmoke ?? []), prior.smoke];
    console.log(`${alias}: installed; ${row.quantization}; ${(row.bytes / 1e9).toFixed(1)} GB`);
    const start = Date.now();
    try {
      const reply = await request('/api/chat', { model: alias, stream: false, think: id === 'local-giant' ? 'low' : false, keep_alive: 0, messages: [{ role: 'user', content: 'Reply with exactly: MODEL_OK' }], options: { num_ctx: 4096, num_predict: id === 'local-giant' ? 256 : 32, temperature: 0 } }, 240000);
      row.smoke = { ok: reply.message?.content?.trim() === 'MODEL_OK', output: reply.message?.content?.slice(0, 160), ms: Date.now() - start, evalCount: reply.eval_count };
    } catch (err) { row.smoke = { ok: false, error: err.message, ms: Date.now() - start }; }
    results = [...results.filter(r => r.source !== source), row];
    writeFileSync(evidenceFile, JSON.stringify(results, null, 2) + '\n');
    console.log(`${alias}: smoke ${row.smoke.ok ? 'PASS' : 'FAIL'} in ${row.smoke.ms}ms${row.smoke.error ? ': ' + row.smoke.error : ''}`);
  }
  if (!wait || selected.every(([, source]) => results.some(r => r.source === source && r.smoke))) break;
  await new Promise(resolve => setTimeout(resolve, 10000));
} while (Date.now() < deadline);
const recommended = results.filter(r => selected.some(([, source]) => r.source === source));
console.log(`Verified installed: ${recommended.length}/5; smoke passed: ${recommended.filter(r => r.smoke?.ok).length}/5.`);
