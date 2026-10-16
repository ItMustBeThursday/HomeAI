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
import { OLLAMA_URL } from './connectors/cli.mjs';
import { createLimiter } from './limiter.mjs';
import { createScheduler } from './scheduler.mjs';
import { createAttachmentStore } from './attachments.mjs';
import { createMemoryStore } from './memory.mjs';
import { createAuth, loadOrCreateToken } from './access.mjs';
import { createShell } from './shell.mjs';
import { createTerminals } from './terminal.mjs';
import { createGithub } from './github.mjs';
import { createVault } from './vault.mjs';
import { createConnections } from './connections.mjs';
import { rotateIfLarge } from './rotate.mjs';
import { createJobs, JOB_SYSTEM } from './jobs.mjs';
import { createGrants, checkFolder } from './grants.mjs';
import { createSystemAccess } from './sysaccess.mjs';
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
  connections: env.HOMEAI_ORCH_CONNECTIONS ?? join(root, 'config', 'connections.json'),
  network: env.HOMEAI_ORCH_NETWORK ?? join(root, 'config', 'network.json'),
  systemAccess: env.HOMEAI_ORCH_SYSACCESS ?? join(root, 'config', 'system-access.json'),
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
// Interactive terminals for the WebUI: persistent shells, any folder, audited into the same exec log.
const terminals = projectsConfig
  ? createTerminals({
      defaultCwd: projectsConfig.projects[projectsConfig.default]?.path,
      audit: (e) => {
        rotateIfLarge(execLog, 5_000_000);
        appendFileSync(execLog, JSON.stringify(e) + '\n');
      },
    })
  : null;
// Account logins: encrypted with Windows DPAPI in data/vault.json (gitignored). The GitHub client prefers a saved login
// over Git Credential Manager, so connecting in the WebUI gives the orchestrator persistent access.
const vault = await createVault({ file: join(dataDir, 'vault.json') });
const connections = createConnections({ vault, config: optionalJson(files.connections, {}) });
const github = projectsConfig?.github ? createGithub({ repo: projectsConfig.github, gitBin, tokenSource: () => connections.getSecret('github') }) : null;

// Standing folder permissions ("always allow"); every agent run gets these in addition to its project folder.
const grants = createGrants({ file: join(dataDir, 'grants.json') });

// Whole-machine access (every drive except OneDrive) for agent runs, so the WebUI agent can work anywhere like a desktop agent.
const systemAccess = createSystemAccess({ config: optionalJson(files.systemAccess, { enabled: false }) });

const orchestrator = createOrchestrator({
  dirsFor: (o) => [...new Set([...grants.dirs(o), ...systemAccess.dirs()])],
  config: readJson(files.routes),
  caps: readJson(files.budgets),
  store: createLedgerStore(join(dataDir, 'ledger.jsonl')),
  history: createTaskHistory(join(dataDir, 'tasks.jsonl')),
  conversations,
  memory,
  run,
  // One request at a time per Ollama GPU; two at a time per CLI so parallel calls queue instead of thrashing.
  limiter: createLimiter({ limits: { ollama: 1, 'claude-cli': 2, 'codex-cli': 2 } }),
  loadedModels: async () => {
    const res = await fetch(`${new URL(ollamaUrl ?? OLLAMA_URL).origin}/api/ps`, { signal: AbortSignal.timeout(1000) });
    return new Set(((await res.json()).models ?? []).map((m) => m.name));
  },
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
// Background jobs: unattended, no approval gate, auto-continue and retry (see jobs.mjs). Persisted in data/jobs.json.
const jobs = createJobs({
  file: join(dataDir, 'jobs.json'),
  concurrency: 2,
  vetFolder: (p) => checkFolder(p),
  grantAlways: (p) => grants.add({ path: p, note: 'Granted from a job request' }),
  run: async ({ job, step, prompt, signal, onEvent }) => {
    const cfg = orchestrator.config;
    const route = step === 'plan' ? cfg.auto?.plan ?? 'plan' : job.route ?? cfg.auto?.act ?? 'agent';
    const agent = orchestrator.isAgentRoute(route);
    let cwd;
    if (agent) {
      if (!shell) return { ok: false, error: 'Shell access is not enabled, so this job cannot run commands' };
      cwd = shell.resolveCwd({ project: job.project });
    }
    const r = await orchestrator.task({ taskType: route, prompt, system: JOB_SYSTEM, source: 'job', cwd, addDirs: job.grants ?? [], signal, onEvent });
    return { ok: r.ok, text: r.text, denials: r.denials, error: r.error, connector: r.connector, model: r.model, taskId: r.id, inputTokens: r.attempts?.reduce((s, a) => s + (a.inputTokens ?? 0), 0), outputTokens: r.attempts?.reduce((s, a) => s + (a.outputTokens ?? 0), 0) };
  },
});
jobs.start();
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
  jobs,
  grants,
  conversations,
  attachments,
  memory,
  shell,
  terminals,
  github,
  connections,
  auth,
  network,
  tokenFile: env.HOMEAI_ORCH_TOKEN ? undefined : tokenFile,
  saveConfig: (kind, obj) => writeConfig(files[kind], obj),
  status,
  webDir: join(root, 'web'),
  version,
}, { port, host });
process.stdout.write(`HomeAI orchestrator ${version} listening on http://${host}:${port} (codex: ${codexScript})\n`);
