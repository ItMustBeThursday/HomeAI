// Local HTTP API (and later the WebUI's static files). Binds to loopback only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const MAX_BODY = 1_000_000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const LOOPBACK_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(data);
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type must be application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

function tokenOk(req, token) {
  if (!token) return true;
  const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

// Input/validation errors from the orchestrator become 400s; "not found" becomes 404.
async function userCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(/not found/i.test(err.message) ? 404 : 400, err.message);
  }
}

// saveConfig(kind, obj) persists an edit ('routes' | 'budgets'); status(config, opts) checks connector health.
export function createApp({ orchestrator, conversations, scheduler, saveConfig, status, token, webDir, version = '0.0.0', now = Date.now }) {
  const api = {
    'GET /api/health': () => ({ ok: true, version }),
    'GET /api/config': () => {
      const { connectors, routes, default: def } = orchestrator.config;
      return { connectors, routes, default: def, caps: orchestrator.caps, editable: !!saveConfig };
    },
    'PUT /api/config/routes': async (req) => {
      if (!saveConfig) throw new HttpError(404, 'Config editing is not enabled');
      const body = await readJson(req);
      await userCall(() => orchestrator.setConfig(body));
      saveConfig('routes', body);
      return { ok: true };
    },
    'PUT /api/config/budgets': async (req) => {
      if (!saveConfig) throw new HttpError(404, 'Config editing is not enabled');
      const body = await readJson(req);
      await userCall(() => orchestrator.setCaps(body));
      saveConfig('budgets', body);
      return { ok: true };
    },
    'GET /api/usage': (req, url) => {
      const hours = Number(url.searchParams.get('hours') ?? 24);
      if (!Number.isFinite(hours) || hours <= 0) throw new HttpError(400, 'hours must be a positive number');
      return { hours, ...orchestrator.usage(now() - hours * 3_600_000), caps: orchestrator.capStatus() };
    },
    'GET /api/status': async (req, url) => {
      if (!status) throw new HttpError(404, 'Status checks are not enabled');
      return status(orchestrator.config, { fresh: url.searchParams.get('fresh') === '1' });
    },
    'GET /api/history': (req, url) => {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, 'limit must be 1-1000');
      return { tasks: orchestrator.history?.list(limit) ?? [] };
    },
    'POST /api/task': async (req) => {
      const body = await readJson(req);
      return userCall(() => orchestrator.task({ taskType: body.taskType, prompt: body.prompt, system: body.system, connector: body.connector }));
    },
    'GET /api/schedule': () => {
      if (!scheduler) throw new HttpError(404, 'Scheduler is not enabled');
      return { ...scheduler.list(), queue: orchestrator.queue() };
    },
    'POST /api/schedule/run': async (req) => {
      if (!scheduler) throw new HttpError(404, 'Scheduler is not enabled');
      const body = await readJson(req);
      return userCall(() => scheduler.runNow(body.name));
    },
    'POST /api/chat': async (req) => {
      const body = await readJson(req);
      return userCall(() => orchestrator.chat({ conversationId: body.conversationId, prompt: body.prompt, taskType: body.taskType, connector: body.connector }));
    },
    'GET /api/conversations': () => {
      if (!conversations) throw new HttpError(404, 'Chat is not enabled');
      return { conversations: conversations.list() };
    },
  };

  // Routes with an :id segment.
  const idApi = {
    'GET /api/conversations/:id': (id) => userCall(() => conversations.get(id) ?? Promise.reject(new Error('Conversation not found'))),
    'PATCH /api/conversations/:id': async (id, req) => {
      const body = await readJson(req);
      if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'title must be a non-empty string');
      return userCall(() => conversations.rename(id, body.title.trim()));
    },
    'DELETE /api/conversations/:id': (id) => userCall(() => (conversations.archive(id), { ok: true, archived: id })),
  };

  function findHandler(method, pathname) {
    const direct = api[`${method} ${pathname}`];
    if (direct) return direct;
    const m = /^\/api\/conversations\/([^/]+)$/.exec(pathname);
    const h = m && conversations && idApi[`${method} /api/conversations/:id`];
    return h ? (req) => h(decodeURIComponent(m[1]), req) : null;
  }

  async function serveStatic(res, pathname) {
    if (!webDir) throw new HttpError(404, 'Not found');
    const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^[\\/]+/, '');
    const file = join(webDir, rel);
    if (rel.startsWith('..') || !file.startsWith(webDir + sep)) throw new HttpError(404, 'Not found');
    let data;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'" });
    res.end(data);
  }

  return async function handle(req, res) {
    try {
      // Rejecting foreign Host headers blocks DNS-rebinding pages from reaching the API.
      if (!LOOPBACK_HOSTS.test(req.headers.host ?? '')) throw new HttpError(421, 'Unexpected Host header');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        const handler = findHandler(req.method, url.pathname);
        if (!handler) throw new HttpError(404, 'Unknown endpoint');
        if (url.pathname !== '/api/health' && !tokenOk(req, token)) throw new HttpError(401, 'Missing or wrong bearer token');
        return send(res, 200, await handler(req, url));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) send(res, status, { ok: false, error: status === 500 ? 'Internal error' : err.message });
      else res.end();
    }
  };
}

export function startServer(options, { port, host = '127.0.0.1' }) {
  const server = createServer(createApp(options));
  // Model calls can take minutes; don't let Node's request timeout cut them off.
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
