// Cross-model context-use eval (local only; no paid calls, no service restart). Runs the SAME tasks through the SAME prompt
// assembly the orchestrator uses (shared system text + MCL retrieval + history budget + effective ctx) for every local text model.
// Usage: node scripts/context-eval.mjs [connectorId ...]   Results: D:/HomeAI/evaluations/context-eval-<date>/report.json
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory.mjs';
import { rememberConversation } from '../src/experience.mjs';
import { buildPrompt } from '../src/history.mjs';
import { effectiveCtx, historyChars, memoryChars } from '../src/budget.mjs';
import { SHARED_SYSTEM, MEMORY_NOTE } from '../src/orchestrator.mjs';
import { buildOllamaRequest } from '../src/connectors/cli.mjs';

const OLLAMA = 'http://127.0.0.1:11435';
const routes = JSON.parse(readFileSync(new URL('../config/routes.json', import.meta.url), 'utf8'));
const want = process.argv.slice(2);
const targets = Object.entries(routes.connectors).filter(([id, c]) => c.kind === 'ollama' && (want.length ? want.includes(id) : true));
const dir = `D:/HomeAI/evaluations/context-eval-${new Date().toISOString().slice(0, 10)}`;
mkdirSync(dir, { recursive: true });

// Synthetic memory: filler conversations plus planted facts. Nothing here is real owner data.
const memory = createMemoryStore(join(dir, `memory-${Date.now()}`));
const filler = (tag, n) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${tag} entry ${i}: ${'Check paths and water plants. '.repeat(10)}` }));
const a = filler('Garden', 120); a[40] = { role: 'user', text: 'Synthetic test only: the zephyr calibration constant is 0.937. Keep this exact number.' };
const b = filler('Garage', 80); b[10] = { role: 'user', text: 'Synthetic test only: the quartz relay is installed in the boathouse.' };
const c = filler('Boathouse', 80); c[20] = { role: 'user', text: 'Synthetic test only: the boathouse lock code rotates every Thursday.' };
const d = filler('Pump', 60); d[30] = { role: 'assistant', text: 'Synthetic test only: I replaced the pump seal and the leak is fixed.' };
for (const [id, msgs] of [['syn-a', a], ['syn-b', b], ['syn-c', c], ['syn-d', d]]) rememberConversation(memory, { id, title: id, messages: msgs });
memory.importMcl('@rules\n!When the user asks for the status codeword, reply with exactly AMBER-7;^3');

const NO = /not (in|found|mentioned|provided|available|stated|given|specified|recorded|know)|no (record|information|mention|data)|don'?t (know|have)|do not (know|have)|unknown|cannot (find|determine|answer)|can'?t (find|determine)|unable|isn'?t (in|mentioned|provided|available|recorded)|insufficient|nothing/i;
const UNVER = /unverif|not (been )?(verified|confirmed)|no (verification|evidence|proof)|unconfirmed|cannot confirm|can'?t confirm|claim/i;
const TASKS = [
  { id: 'recall', q: 'What is the zephyr calibration constant? Reply with only the number.', ok: (t) => /\b0\.937\b/.test(t) },
  { id: 'join', q: 'On which day does the lock code rotate where the quartz relay is installed? Reply with only the day.', ok: (t) => /thursday/i.test(t) },
  { id: 'abstain', q: 'What is the melody frequency of the neighbor chime? If the memory does not say, reply that it is not recorded.', ok: (t) => NO.test(t) && !/\b0\.937\b/.test(t) },
  { id: 'unverified', q: 'Was the pump leak fix independently verified, or only claimed by the assistant? Answer in one short sentence.', ok: (t) => UNVER.test(t) },
  { id: 'rule', q: 'status codeword?', ok: (t) => /AMBER-7/.test(t) },
  { id: 'history', q: 'Earlier in this conversation I gave you a project name. What was it? Reply with only the name.', ok: (t) => /bluefin/i.test(t),
    history: () => { const m = filler('Chat', 70); m[2] = { role: 'user', text: 'Synthetic test only: the project name is BLUEFIN. Remember it.' }; m[3] = { role: 'assistant', text: 'Noted.' }; return m; } },
];

async function ask(entry, task) {
  const sysMem = task.history ? '' : memory.context(task.q, { format: 'mcl', maxChars: memoryChars([entry]), limit: 20 });
  const system = [SHARED_SYSTEM, 'You are HomeAI, a helpful assistant for a family home. Answer clearly and concisely.', sysMem, sysMem ? MEMORY_NOTE : ''].filter(Boolean).join('\n\n');
  const prompt = task.history ? buildPrompt(task.history(), task.q, historyChars([entry])) : task.q;
  const { body } = buildOllamaRequest({ model: entry.model, prompt, system, ctx: effectiveCtx(entry) });
  const started = Date.now();
  const res = await fetch(OLLAMA + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(600_000),
    body: JSON.stringify({ ...body, stream: false, keep_alive: '5m', options: { ...body.options, temperature: 0, num_predict: 3072 } }) });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  const text = j.message?.content ?? '';
  return { pass: !!task.ok(text), ms: Date.now() - started, inTok: j.prompt_eval_count, outTok: j.eval_count, out: text.replace(/\s+/g, ' ').slice(0, 160), memChars: sysMem.length };
}

const report = { when: new Date().toISOString(), ctx: effectiveCtx({ kind: 'ollama' }), note: 'synthetic tasks; temperature 0; single run per task; keyword retrieval (no embedder)', models: {} };
for (const [id, cn] of targets) {
  const entry = { connector: id, kind: 'ollama', model: cn.model, ...(process.env.KEEP_CONNECTOR_CTX && Number.isInteger(cn.ctx) ? { ctx: cn.ctx } : {}) };
  const row = { model: cn.model, ctx: effectiveCtx(entry), tasks: {} };
  for (const t of TASKS.filter((x) => !process.env.TASKS_ONLY || process.env.TASKS_ONLY.split(',').includes(x.id))) {
    try { row.tasks[t.id] = await ask(entry, t); } catch (err) { row.tasks[t.id] = { pass: false, error: String(err.message).slice(0, 160) }; }
    const r = row.tasks[t.id];
    console.log(`${id} ${t.id}: ${r.pass ? 'PASS' : 'FAIL'} ${r.ms ?? ''}ms ${r.out ?? r.error ?? ''}`);
  }
  row.score = `${Object.values(row.tasks).filter((x) => x.pass).length}/${Object.keys(row.tasks).length}`;
  report.models[id] = row;
  writeFileSync(join(dir, process.env.REPORT_NAME || 'report.json'), JSON.stringify(report, null, 2));
  await fetch(OLLAMA + '/api/generate', { method: 'POST', body: JSON.stringify({ model: cn.model, keep_alive: 0 }) }).catch(() => {}); // free RAM before the next model
}
console.log(Object.entries(report.models).map(([k, v]) => `${k}=${v.score}`).join('  '));
