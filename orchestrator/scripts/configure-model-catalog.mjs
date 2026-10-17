import { readFileSync, writeFileSync } from 'node:fs';
import { validateRoutes } from '../src/router.mjs';
const path = new URL('../config/routes.json', import.meta.url);
const cfg = JSON.parse(readFileSync(path, 'utf8'));
for (const c of Object.values(cfg.connectors)) if (c.category === 'Heavyweight (large MoE)') c.category = 'Heavyweight / CPU offload';
const notes = {
  'local-giant': 'Reasoning specialist; ~65 GB MXFP4 weights. CPU offload required; runtime unverified.',
  'local-deep': 'Deep analysis and long-form text; ~50 GB Q4 weights. CPU offload required; runtime unverified.',
  'local-main': 'General chat, research and coding; ~18 GB Q4 weights. runtime unverified.',
  'local-coder-next': 'Coding specialist; ~52 GB weights. CPU offload required; runtime unverified. Text route, no shell tools.',
  'local-moe-fast': 'General chat + vision; ~22 GB weights, exceeds actual 20 GB VRAM. CPU offload required; runtime unverified.',
};
let evidence = [];
try { evidence = JSON.parse(readFileSync('D:/HomeAI/evaluations/model-catalog-20261016.json', 'utf8')); } catch {}
let installed = [];
try {
  const response = await fetch('http://127.0.0.1:11435/api/tags', { signal: AbortSignal.timeout(5000) });
  if (response.ok) installed = (await response.json()).models.map(m => m.name);
} catch {}
for (const [id, note] of Object.entries(notes)) {
  const check = evidence.find(r => r.id === id);
  if (check?.capabilities?.includes('vision')) cfg.connectors[id].vision = true;
  const outcome = check?.smoke?.ok ? `Text smoke passed at 4096 context; ${cfg.connectors[id].vision ? 'vision and quality' : 'quality'} unverified.` : check?.smoke ? 'Text smoke failed; not runtime validated.' : 'runtime unverified.';
  Object.assign(cfg.connectors[id], { recommended: true, note: 'Local shortlist. ' + (check || installed.includes(cfg.connectors[id].model) ? '' : 'Download pending. ') + note.replace('runtime unverified.', outcome), ctx: 4096, startTimeoutMs: 240000 });
}
// Preserve the failed candidate on disk in Ollama; omit unsafe choices from active routes.
for (const id of ['local-flagship-qwen122', 'local-flagship-mistral', 'local-flagship-nemotron']) delete cfg.connectors[id];
cfg.routes.flagship = { chain: ['local-giant', 'local-deep', 'local-main'], memory: true };
cfg.routes['coding-local'].chain = cfg.routes['coding-local'].chain.filter(id => cfg.connectors[id].kind === 'ollama');
cfg.routes['general-local'] ??= { chain: ['local-moe-fast', 'local-main', 'local-fast'], memory: true };
validateRoutes(cfg);
writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
console.log('Catalog updated: 5 shortlisted models, 4096 context; new routes use local models only.');
