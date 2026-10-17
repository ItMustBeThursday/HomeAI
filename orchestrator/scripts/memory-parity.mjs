// Local-only synthetic acceptance across configured text models. No production history or memory writes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../src/memory.mjs';
import { rememberConversation } from '../src/experience.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { createRunner } from '../src/connectors/run.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'config/routes.json'), 'utf8').replace(/^\uFEFF/, ''));
const arg = name => process.argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
const requested = arg('--connector');
const startupMs = Number(arg('--startup-ms') ?? 240000);
if (!Number.isInteger(startupMs) || startupMs < 1000 || startupMs > 900000) throw Error('Invalid startup allowance');
const out = `D:/HomeAI/evaluations/memory-parity-${Date.now()}`;
mkdirSync(out, { recursive: true });
const memory = createMemoryStore(join(out, 'memory'));
const messages = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
  text: `Garden maintenance entry ${i}: ${'Check paths and water plants. '.repeat(12)}` }));
messages[100] = { role: 'user', text: 'Synthetic Zephyr record, obsolete: calibration constant is 0.937.' };
messages[110] = { role: 'user', text: 'Synthetic Zephyr correction, current: calibration constant is 0.941, not 0.937. The output directory is D:/Zephyr/results. Automatic publishing is NOT approved.' };
rememberConversation(memory, { id: 'synthetic-zephyr', title: 'Synthetic Zephyr records', messages });
const query = 'From the current corrected Zephyr record, give calibration constant, output directory and whether automatic publishing is approved. Reply as JSON with keys constant, directory, publishingApproved. Use a boolean for publishingApproved.';
const packet = memory.context(query, { format: 'mcl', maxChars: 1200, limit: 20 });
writeFileSync(join(out, 'packet.txt'), packet);
const report = { startedAt: new Date().toISOString(), rawChars: JSON.stringify(messages).length,
  packetChars: packet.length, packetHasCorrection: packet.includes('0.941') && packet.includes('0.937'),
  scope: 'Synthetic selective recall, correction, exact path and negation at 4096 context. Not a general reasoning or tool-use benchmark.', models: [] };
const installedResponse = await fetch('http://127.0.0.1:11435/api/tags', { signal: AbortSignal.timeout(10000) });
if (!installedResponse.ok) throw Error(`Local inventory HTTP ${installedResponse.status}`);
const installed = (await installedResponse.json()).models.map(m => m.name);
const selected = Object.entries(config.connectors).filter(([id, c]) => c.kind === 'ollama' && (!requested || id === requested));
if (!selected.length) throw Error('No configured local text connector selected');
for (const [id, connector] of selected) {
  const row = { connector: id, model: connector.model, ctx: 4096, startupMs };
  report.models.push(row);
  if (!installed.includes(connector.model)) { row.ok = false; row.error = 'Configured model not installed'; }
  else {
    const run = createRunner({ ollamaUrl: 'http://127.0.0.1:11435/api/chat', startTimeoutMs: startupMs, timeoutMs: 240000,
      fetchImpl: (url, opts) => {
        if (String(url) !== 'http://127.0.0.1:11435/api/chat') throw Error('Non-local request refused');
        const body = JSON.parse(opts.body);
        return fetch(url, { ...opts, body: JSON.stringify({ ...body, keep_alive: 0,
          think: id === 'local-giant' ? 'low' : false,
          options: { ...body.options, temperature: 0, num_predict: 512 } }) });
      } });
    const o = createOrchestrator({ config: { connectors: { probe: { ...connector, ctx: 4096, startTimeoutMs: startupMs } },
      routes: { probe: { chain: ['probe'] } }, default: 'probe' }, memory, run });
    console.log(`${id}: testing shared orchestrator context`);
    const result = await o.task({ prompt: query, signal: AbortSignal.timeout(startupMs + 240000) });
    row.ms = result.ms;
    row.inputTokens = result.attempts[0]?.inputTokens;
    row.outputTokens = result.attempts[0]?.outputTokens;
    // Only synthetic model output is retained. No credentials or real owner content enter this run.
    row.output = result.text;
    row.attemptError = result.attempts[0]?.error;
    let answer;
    try { answer = JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] ?? ''); } catch {}
    row.checks = { constant: String(answer?.constant) === '0.941', directory: answer?.directory === 'D:/Zephyr/results', negation: answer?.publishingApproved === false };
    row.ok = result.ok && Object.values(row.checks).every(Boolean);
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${id}: ${row.ok ? 'PASS' : 'FAIL'} (${row.ms ?? 0}ms)`);
}
report.finishedAt = new Date().toISOString();
report.passed = report.models.filter(m => m.ok).length;
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ out, tested: report.models.length, passed: report.passed }));
if (report.passed !== report.models.length || !report.packetHasCorrection) process.exitCode = 1;
