// Service entry point: node src/main.mjs
import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrchestrator } from './orchestrator.mjs';
import { createLedgerStore } from './store.mjs';
import { createTaskHistory, createConversationStore } from './history.mjs';
import { createConfigWriter } from './configfiles.mjs';
import { createStatusChecker } from './status.mjs';
import { createRunner } from './connectors/run.mjs';
import { createLimiter } from './limiter.mjs';
import { createScheduler } from './scheduler.mjs';
import { createAttachmentStore } from './attachments.mjs';
import { createMemoryStore } from './memory.mjs';
import { createAuth, loadOrCreateToken } from './access.mjs';
import { createShell } from './shell.mjs';
import { createGithub } from './github.mjs';
import { rotateIfLarge } from './rotate.mjs';
import { startServer } from './server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const optionalJson = (p, fallback) => (existsSync(p) ? readJson(p) : fallback);

const files = {
  schedule: env.HOMEAI_ORCH_SCHEDULE ?? join(root, 'config', 'schedule.json'),
  routes: env.HOMEAI_ORCH_ROUTES ?? join(root, 'config', 'routes.json'),
  budgets: env.HOMEAI_ORCH_BUDGETS ?? join(root, 'config', 'budgets.json'),
  projects: env.HOMEAI_ORCH_PROJECTS ?? join(root, 'config', 'projects.json'),
  network: env.HOMEAI_ORCH_NETWORK ?? join(root, 'config', 'network.json'),
};
const dataDir = env.HOMEAI_ORCH_DATA ?? join(root, 'data');
const scratch = join(dataDir, 'scratch');
mkdirSync(scratch, { recursive: true });

const claudeBin = env.HOMEAI_CLAUDE_BIN ?? 'claude';
// Standalone Codex install (does not depend on OpenClaw); the old OpenClaw-bundled copy is only a fallback.
const STANDALONE_CODEX = 'D:\\HomeAI\\runtime\\codex\\node_modules\\@openai\\codex\\bin\\codex.js';
const LEGACY_CODEX = 'D:\\HomeAI\\state\\openclaw\\npm\\projects\\openclaw-codex-8902d781d4\\node_modules\\@openai\\codex\\bin\\codex.js';
const codexScript = env.HOMEAI_CODEX_SCRIPT ?? (existsSync(STANDALONE_CODEX) ? STANDALONE_CODEX : LEGACY_CODEX);
const ollamaUrl = env.HOMEAI_OLLAMA_URL;
const gitBin = env.HOMEAI_GIT_BIN ?? (existsSync('D:\\HomeAI\\runtime\\git\\cmd\\git.exe') ? 'D:\\HomeAI\\runtime\\git\\cmd\\git.exe' : 'git');

const run = createRunner({
  claudeBin,
  codexScript,
  ollamaUrl,
  // Empty working dir so the CLIs don't pick up project instructions from wherever the service was started.
  cwd: scratch,
});

const conversations = createConversationStore(join(dataDir, 'conversations'));
const attachments = createAttachmentStore(join(dataDir, 'attachments'));
const memory = createMemoryStore(join(dataDir, 'memory'));

// Shell/project access exists only when config/projects.json does.
const projectsConfig = optionalJson(files.projects, null);
const execLog = join(dataDir, 'exec.jsonl');
const shell = projectsConfig
  ? createShell({
      config: projectsConfig,
      gitBin,
      audit: (e) => {
        rotateIfLarge(execLog, 5_000_000);
        appendFileSync(execLog, JSON.stringify(e) + '\n');
      },
    })
  : null;
const github = projectsConfig?.github ? createGithub({ repo: projectsConfig.github, gitBin }) : null;

const orchestrator = createOrchestrator({
  config: readJson(files.routes),
  caps: readJson(files.budgets),
  store: createLedgerStore(join(dataDir, 'ledger.jsonl')),
  history: createTaskHistory(join(dataDir, 'tasks.jsonl')),
  conversations,
  memory,
  run,
  // One request at a time per Ollama GPU; two at a time per CLI so parallel calls queue instead of thrashing.
  limiter: createLimiter({ limits: { ollama: 1, 'claude-cli': 2, 'codex-cli': 2 } }),
});

// Scheduler (off unless config/schedule.json has "enabled": true). Run log: data/schedule.jsonl.
const scheduleLog = join(dataDir, 'schedule.jsonl');
const lastRuns = {};
if (existsSync(scheduleLog)) {
  for (const line of readFileSync(scheduleLog, 'utf8').split(/\r?\n/)) {
    try {
      const e = JSON.parse(line);
      if (e.job && e.ts) lastRuns[e.job] = e.ts;
    } catch {}
  }
}
const scheduler = createScheduler({
  config: optionalJson(files.schedule, { enabled: false, jobs: [] }),
  cwd: root,
  lastRuns,
  record: (e) => appendFileSync(scheduleLog, JSON.stringify(e) + '\n'),
  // Prompt jobs ask a model; on an agent route they also need a project folder.
  runPrompt: (job) => orchestrator.task({ taskType: job.taskType, prompt: job.prompt, source: 'schedule', cwd: job.project && shell ? shell.resolveCwd({ project: job.project }) : undefined }),
});
scheduler.start();
const writeConfig = createConfigWriter(join(dataDir, 'config-backups'));
const status = createStatusChecker({ ollamaBase: ollamaUrl ? new URL(ollamaUrl).origin : undefined, claudeBin, codexScript });

// Access: an admin token is always required (auto-created in data/token.txt); devices get limited tokens.
const tokenFile = join(dataDir, 'token.txt');
const adminToken = env.HOMEAI_ORCH_TOKEN || loadOrCreateToken(tokenFile);
const auth = createAuth({ adminToken, devicesFile: join(dataDir, 'devices.json') });
const network = optionalJson(files.network, {});
const host = env.HOMEAI_ORCH_HOST ?? network.host ?? '127.0.0.1';

const port = Number(env.HOMEAI_ORCH_PORT ?? 18850);
const { version } = readJson(join(root, 'package.json'));
await startServer({
  orchestrator,
  scheduler,
  conversations,
  attachments,
  memory,
  shell,
  github,
  auth,
  network,
  tokenFile: env.HOMEAI_ORCH_TOKEN ? undefined : tokenFile,
  saveConfig: (kind, obj) => writeConfig(files[kind], obj),
  status,
  webDir: join(root, 'web'),
  version,
}, { port, host });
process.stdout.write(`HomeAI orchestrator ${version} listening on http://${host}:${port} (codex: ${codexScript})\n`);
