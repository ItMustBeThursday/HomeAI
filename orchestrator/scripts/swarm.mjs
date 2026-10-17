// Usage: node scripts/swarm.mjs [--local-only] [--status] "task text"
// Local planner/merger = Ollama (HOMEAI_OLLAMA_URL, default http://127.0.0.1:11435). Hosted keys via env HOMEAI_KEY_*.
import { readFileSync } from 'node:fs';
import { createHostedClient } from '../src/hosted.mjs';
import { createSwarm } from '../src/swarm.mjs';

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
const localOnly = flag('--local-only');
const status = flag('--status');
const cfg = JSON.parse(readFileSync(new URL('../config/free-providers.json', import.meta.url), 'utf8'));
const providers = cfg.providers.map((p) => ({ ...p, enabled: !!process.env[p.keyEnv] }));
if (status) {
  for (const p of providers) console.log(`${p.id.padEnd(11)} ${p.enabled ? 'key set' : 'no key (disabled)'}  rpm=${p.rpm} rpd=${p.rpd}  ${p.models.join(', ')}`);
  process.exit(0);
}
const task = args.join(' ').trim();
if (!task) { console.error('Give a task.'); process.exit(2); }
const base = process.env.HOMEAI_OLLAMA_URL ?? 'http://127.0.0.1:11435';
const model = process.env.HOMEAI_SWARM_LOCAL ?? 'homeai-fast:locked';
const local = async ({ prompt, system }) => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ model, stream: false, think: false, options: { num_ctx: 4096 }, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
  const j = await res.json();
  return { text: j.message?.content ?? '', inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0 };
};
const swarm = createSwarm({ providers, hosted: createHostedClient(), local, log: (m) => console.error(m) });
const out = await swarm(task, { allowHosted: !localOnly });
console.log(out.answer);
console.error(JSON.stringify({ planned: out.planned, hostedUsed: out.hostedUsed, blockedSensitive: out.blockedSensitive, parts: out.parts, verified: out.verified }, null, 1));
