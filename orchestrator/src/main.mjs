// Service entry point: node src/main.mjs
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrchestrator } from './orchestrator.mjs';
import { createLedgerStore } from './store.mjs';
import { createTaskHistory, createConversationStore } from './history.mjs';
import { createConfigWriter } from './configfiles.mjs';
import { createStatusChecker } from './status.mjs';
import { createRunner } from './connectors/run.mjs';
import { startServer } from './server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const files = {
  routes: env.HOMEAI_ORCH_ROUTES ?? join(root, 'config', 'routes.json'),
  budgets: env.HOMEAI_ORCH_BUDGETS ?? join(root, 'config', 'budgets.json'),
};
const dataDir = env.HOMEAI_ORCH_DATA ?? join(root, 'data');
const scratch = join(dataDir, 'scratch');
mkdirSync(scratch, { recursive: true });

const claudeBin = env.HOMEAI_CLAUDE_BIN ?? 'claude';
const codexScript = env.HOMEAI_CODEX_SCRIPT ?? 'D:\\HomeAI\\state\\openclaw\\npm\\projects\\openclaw-codex-8902d781d4\\node_modules\\@openai\\codex\\bin\\codex.js';
const ollamaUrl = env.HOMEAI_OLLAMA_URL;

const run = createRunner({
  claudeBin,
  codexScript,
  ollamaUrl,
  // Empty working dir so the CLIs don't pick up project instructions from wherever the service was started.
  cwd: scratch,
});

const conversations = createConversationStore(join(dataDir, 'conversations'));
const orchestrator = createOrchestrator({
  config: readJson(files.routes),
  caps: readJson(files.budgets),
  store: createLedgerStore(join(dataDir, 'ledger.jsonl')),
  history: createTaskHistory(join(dataDir, 'tasks.jsonl')),
  conversations,
  run,
});
const writeConfig = createConfigWriter(join(dataDir, 'config-backups'));
const status = createStatusChecker({ ollamaBase: ollamaUrl ? new URL(ollamaUrl).origin : undefined, claudeBin, codexScript });

const port = Number(env.HOMEAI_ORCH_PORT ?? 18850);
const { version } = readJson(join(root, 'package.json'));
await startServer({
  orchestrator,
  conversations,
  saveConfig: (kind, obj) => writeConfig(files[kind], obj),
  status,
  token: env.HOMEAI_ORCH_TOKEN || undefined,
  webDir: join(root, 'web'),
  version,
}, { port });
process.stdout.write(`HomeAI orchestrator ${version} listening on http://127.0.0.1:${port}\n`);
