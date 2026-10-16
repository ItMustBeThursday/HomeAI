// MCP server (stdio, newline-delimited JSON-RPC) so Claude and other MCP clients can use the orchestrator:
// ask models by route, run agents, use the shell/tests/git/GitHub, read usage, search memory.
// It is a thin client of the HTTP API and uses the admin token from data/token.txt (or HOMEAI_ORCH_TOKEN).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL = '2024-11-05';
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function loadImages(paths = [], read = readFileSync) {
  return paths.map((p) => {
    const mediaType = IMAGE_TYPES[extname(p).toLowerCase()];
    if (!mediaType) throw new Error(`Unsupported image type: ${p}`);
    return { name: p.split(/[\\/]/).pop(), mediaType, data: read(p).toString('base64') };
  });
}

const clip = (s, n = 60_000) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} characters]` : s);
const modelLine = (r) => `[${r.connector} · ${r.model} · route ${r.taskType} · ${((r.ms ?? 0) / 1000).toFixed(1)}s${r.attempts?.length > 1 ? ` · ${r.attempts.length} attempts` : ''}]`;

function formatExec(r) {
  const parts = [`exit ${r.code}${r.timedOut ? ' (timed out)' : ''} in ${((r.ms ?? 0) / 1000).toFixed(1)}s${r.cwd ? ` · ${r.cwd}` : ''}`];
  if (r.stdout?.trim()) parts.push(r.stdout.trimEnd());
  if (r.stderr?.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  if (r.truncated) parts.push('[output truncated]');
  return parts.join('\n');
}

// Each tool: schema plus run(args, api) → text. api(method, path, body) returns parsed JSON or throws.
export const TOOLS = {
  ask: {
    description: 'Send one prompt through an orchestrator route (quick, general, coding, review, planning, vision) and get the answer plus which model answered. Use to offload work to cheaper or local models.',
    schema: obj({ prompt: str('The prompt'), route: str('Route name; default is the orchestrator default'), model: str('Pin one connector, e.g. local-main or claude-haiku'), system: str('Optional system prompt'), images: { type: 'array', items: str('Path of an image file'), description: 'Image files for vision routes' } }, ['prompt']),
    async run(a, api, deps) {
      const r = await api('POST', '/api/task', { prompt: a.prompt, taskType: a.route, connector: a.model, system: a.system, images: a.images ? loadImages(a.images, deps.read) : undefined });
      if (!r.ok) throw new Error(`${r.error ?? 'Task failed'} ${modelLine(r)}`);
      return `${r.text}\n\n${modelLine(r)}`;
    },
  },
  chat: {
    description: 'Continue (or start) a saved orchestrator conversation. Returns the reply and the conversation id.',
    schema: obj({ prompt: str('Message'), conversationId: str('Existing conversation id; omit to start one'), route: str('Route name'), model: str('Pin one connector') }, ['prompt']),
    async run(a, api) {
      const r = await api('POST', '/api/chat', { prompt: a.prompt, conversationId: a.conversationId, taskType: a.route, connector: a.model });
      if (!r.reply.ok) throw new Error(r.reply.error ?? 'Chat failed');
      return `${r.reply.text}\n\n${modelLine(r.reply)} · conversation ${r.conversation.id}`;
    },
  },
  agent: {
    description: 'Hand a job to a coding agent (Claude or Codex) that can run commands, edit files, run tests and use git inside a registered project. Returns its report. Runs can take several minutes.',
    schema: obj({ prompt: str('What to do'), project: str('Project name from the projects tool; default is the workspace'), model: str('Pin claude-sonnet or codex') }, ['prompt']),
    async run(a, api) {
      const r = await api('POST', '/api/task', { prompt: a.prompt, taskType: 'agent', project: a.project, connector: a.model });
      if (!r.ok) throw new Error(`${r.error ?? 'Agent failed'} ${modelLine(r)}`);
      return `${r.text}\n\n${modelLine(r)}`;
    },
  },
  shell: {
    description: 'Run a PowerShell command in a registered project folder (audited; cannot leave the project; OneDrive is refused).',
    schema: obj({ command: str('PowerShell command'), project: str('Project name'), cwd: str('Subfolder inside the project'), timeoutSeconds: { type: 'integer', minimum: 1, maximum: 1800 } }, ['command']),
    async run(a, api) {
      const r = await api('POST', '/api/exec', { command: a.command, project: a.project, cwd: a.cwd, timeoutMs: a.timeoutSeconds ? a.timeoutSeconds * 1000 : undefined });
      if (!r.ok) throw Object.assign(new Error(formatExec(r)), { raw: true });
      return formatExec(r);
    },
  },
  run_tests: {
    description: "Run a project's configured test command and report pass/fail counts and output.",
    schema: obj({ project: str('Project name (see projects)') }, ['project']),
    async run(a, api) {
      const r = await api('POST', `/api/projects/${encodeURIComponent(a.project)}/test`, {});
      const text = `${r.ok ? 'PASS' : 'FAIL'} · pass ${r.pass ?? '?'} · fail ${r.fail ?? '?'}\n${clip(r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : ''), 20_000)}`;
      if (!r.ok) throw Object.assign(new Error(text), { raw: true });
      return text;
    },
  },
  git: {
    description: 'Git for a project: status, log, diff, remote, or sync (publishes the project to GitHub using its sync script; needs a commit message).',
    schema: obj({ project: str('Project name'), action: { type: 'string', enum: ['status', 'log', 'diff', 'remote', 'sync'] }, message: str('Commit message (sync only)') }, ['project', 'action']),
    async run(a, api) {
      const r = await api('POST', `/api/projects/${encodeURIComponent(a.project)}/git`, { action: a.action, message: a.message });
      if (!r.ok) throw Object.assign(new Error(formatExec(r)), { raw: true });
      return formatExec(r);
    },
  },
  projects: {
    description: 'List registered projects (name, path, whether tests and GitHub sync are configured).',
    schema: obj({}),
    async run(a, api) {
      const r = await api('GET', '/api/projects');
      return r.projects.map((p) => `${p.name}${p.name === r.default ? ' (default)' : ''}: ${p.path}${p.canTest ? ' · tests' : ''}${p.canSync ? ' · sync' : ''}${p.git ? ' · git' : ''}${p.description ? ` — ${p.description}` : ''}`).join('\n');
    },
  },
  usage: {
    description: 'Token and call usage by model and route over a window, with daily budget status.',
    schema: obj({ hours: { type: 'number', description: 'Window in hours (default 24)' } }),
    async run(a, api) {
      const r = await api('GET', `/api/usage?hours=${a.hours ?? 24}`);
      const rows = Object.entries(r.byConnector).map(([k, t]) => `${k}: ${t.calls} calls, ${t.inputTokens} in / ${t.outputTokens} out`);
      const caps = r.caps.map((c) => `${c.scope} ${c.name} ${c.metric}: ${c.used}/${c.limit}`);
      return [`Last ${r.hours}h: ${r.total.calls} calls, ${r.total.inputTokens} in / ${r.total.outputTokens} out`, ...rows, caps.length ? 'Budgets:' : '', ...caps].filter(Boolean).join('\n');
    },
  },
  status: {
    description: 'Health of Claude, Codex and Ollama and of each connector.',
    schema: obj({}),
    async run(a, api) {
      const r = await api('GET', '/api/status?fresh=1');
      return Object.entries(r.connectors).map(([k, c]) => `${k} (${c.model}): ${c.ok ? 'ready' : `unavailable${c.detail ? ` - ${c.detail}` : ''}`}`).join('\n');
    },
  },
  history: {
    description: 'Recent tasks with route, answering model, result and token counts.',
    schema: obj({ limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    async run(a, api) {
      const r = await api('GET', `/api/history?limit=${a.limit ?? 10}`);
      return r.tasks.map((t) => `${new Date(t.ts).toISOString()} ${t.ok ? 'ok ' : 'FAIL'} ${t.taskType} → ${t.connector ?? '-'} ${((t.ms ?? 0) / 1000).toFixed(1)}s: ${String(t.prompt ?? '').slice(0, 80).replace(/\s+/g, ' ')}`).join('\n') || 'No tasks yet.';
    },
  },
  memory_search: {
    description: 'Search the orchestrator memory (durable facts and preferences). Empty query lists everything.',
    schema: obj({ query: str('Words to look for') }),
    async run(a, api) {
      const r = await api('GET', `/api/memory${a.query ? `?q=${encodeURIComponent(a.query)}` : ''}`);
      return r.notes.map((n) => `[${n.id}] ${n.title}${n.tags.length ? ` (${n.tags.join(', ')})` : ''}: ${n.text}`).join('\n\n') || 'No matching notes.';
    },
  },
  memory_add: {
    description: "Save a durable fact or preference to the orchestrator memory. Tag 'core' only for rules every route must always see.",
    schema: obj({ title: str('Short title'), text: str('The fact'), tags: { type: 'array', items: { type: 'string' } } }, ['title', 'text']),
    async run(a, api) {
      const n = await api('POST', '/api/memory', { title: a.title, text: a.text, tags: a.tags });
      return `Saved note ${n.id}.`;
    },
  },
  connections: {
    description: 'List account connections (GitHub etc.): which are logged in and as whom. Never shows credentials.',
    schema: obj({}),
    async run(a, api) {
      return (await api('GET', '/api/connections')).connections.map((c) => `${c.name}: ${c.connected ? `connected as ${c.account}` : c.needsLogin ? 'needs a new login' : 'not connected'}`).join(String.fromCharCode(10));
    },
  },
  github: {
    description: 'GitHub for the HomeAI repo: summary (latest commits, workflow runs), issues (open/closed/all), or runs.',
    schema: obj({ what: { type: 'string', enum: ['summary', 'issues', 'runs'] }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['what']),
    async run(a, api) {
      if (a.what === 'summary') return JSON.stringify(await api('GET', '/api/github'), null, 2);
      if (a.what === 'runs') return JSON.stringify((await api('GET', '/api/github/runs')).runs, null, 2);
      return JSON.stringify((await api('GET', `/api/github/issues?state=${a.state ?? 'open'}`)).issues, null, 2);
    },
  },
  github_create_issue: {
    description: 'Create an issue in the public HomeAI GitHub repo. This publishes text publicly; only use when the user asked for it.',
    schema: obj({ title: str('Issue title'), body: str('Issue body') }, ['title']),
    async run(a, api) {
      const i = await api('POST', '/api/github/issues', { title: a.title, body: a.body });
      return `Created issue #${i.number}: ${i.url}`;
    },
  },
  schedule_run: {
    description: 'Run a scheduled job now (e.g. nightly-backup) and report its output.',
    schema: obj({ name: str('Job name') }, ['name']),
    async run(a, api) {
      const r = await api('POST', '/api/schedule/run', { name: a.name });
      return `${r.ok ? 'ok' : 'failed'} (exit ${r.code}): ${r.output}`;
    },
  },
};

// api(method, path, body) → JSON; read/write are injectable for tests.
export function createMcpServer({ api, version = '0.0.0', read = readFileSync } = {}) {
  const deps = { read };
  async function handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize':
        return reply({ protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'homeai-orchestrator', version } });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) });
      case 'tools/call': {
        const tool = Object.hasOwn(TOOLS, params?.name) ? TOOLS[params.name] : null;
        if (!tool) return fail(-32602, `Unknown tool "${params?.name}"`);
        try {
          return reply({ content: [{ type: 'text', text: clip(await tool.run(params.arguments ?? {}, api, deps)) }] });
        } catch (err) {
          return reply({ isError: true, content: [{ type: 'text', text: clip(err.message) }] });
        }
      }
      default:
        // Notifications (no id) get no reply; unknown requests get an error.
        return id === undefined ? null : fail(-32601, `Method not found: ${method}`);
    }
  }
  return {
    handle,
    // One line in → one line out (or '' for notifications).
    async handleLine(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
      const out = await handle(msg);
      return out ? JSON.stringify(out) : '';
    },
  };
}

export function createHttpApi({ baseUrl, token, fetchImpl = fetch }) {
  return async function api(method, path, body) {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const tokenFile = process.env.HOMEAI_ORCH_TOKEN_FILE ?? join(root, 'data', 'token.txt');
  const token = process.env.HOMEAI_ORCH_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
  if (!token) {
    process.stderr.write(`No orchestrator token: set HOMEAI_ORCH_TOKEN or start the service once to create ${tokenFile}\n`);
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const server = createMcpServer({ api: createHttpApi({ baseUrl: process.env.HOMEAI_ORCH_URL ?? 'http://127.0.0.1:18850', token }), version });
  let buf = '';
  let pending = Promise.resolve();
  process.stdin.setEncoding('utf8').on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      // Handled concurrently, but each reply is written whole.
      pending = Promise.all([pending, server.handleLine(line).then((out) => out && process.stdout.write(`${out}\n`))]);
    }
  });
  process.stdin.on('end', () => pending.then(() => process.exit(0)));
}
