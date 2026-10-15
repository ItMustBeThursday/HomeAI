// Service entry point: node src/main.mjs
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrchestrator } from './orchestrator.mjs';
import { createLedgerStore } from './store.mjs';
import { createRunner } from './connectors/run.mjs';
import { startServer } from './server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const config = readJson(env.HOMEAI_ORCH_ROUTES ?? join(root, 'config', 'routes.json'));
const caps = readJson(env.HOMEAI_ORCH_BUDGETS ?? join(root, 'config', 'budgets.json'));
const dataDir = env.HOMEAI_ORCH_DATA ?? join(root, 'data');
const scratch = join(dataDir, 'scratch');
mkdirSync(scratch, { recursive: true });

const run = createRunner({
  claudeBin: env.HOMEAI_CLAUDE_BIN ?? 'claude',
  codexScript: env.HOMEAI_CODEX_SCRIPT ?? 'D:\\HomeAI\\state\\openclaw\\npm\\projects\\openclaw-codex-8902d781d4\\node_modules\\@openai\\codex\\bin\\codex.js',
  ollamaUrl: env.HOMEAI_OLLAMA_URL,
  // Empty working dir so the CLIs don't pick up project instructions from wherever the service was started.
  cwd: scratch,
});

const orchestrator = createOrchestrator({ config, caps, store: createLedgerStore(join(dataDir, 'ledger.jsonl')), run });
const port = Number(env.HOMEAI_ORCH_PORT ?? 18850);
const { version } = readJson(join(root, 'package.json'));
await startServer({ orchestrator, token: env.HOMEAI_ORCH_TOKEN || undefined, webDir: join(root, 'web'), version }, { port });
process.stdout.write(`HomeAI orchestrator ${version} listening on http://127.0.0.1:${port}\n`);
