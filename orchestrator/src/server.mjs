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

export function createApp({ orchestrator, token, webDir, version = '0.0.0', now = Date.now }) {
  const api = {
    'GET /api/health': () => ({ ok: true, version }),
    'GET /api/config': () => {
      const { connectors, routes, default: def } = orchestrator.config;
      return { connectors, routes, default: def, caps: orchestrator.caps };
    },
    'GET /api/usage': (req, url) => {
      const hours = Number(url.searchParams.get('hours') ?? 24);
      if (!Number.isFinite(hours) || hours <= 0) throw new HttpError(400, 'hours must be a positive number');
      return { hours, ...orchestrator.usage(now() - hours * 3_600_000) };
    },
    'POST /api/task': async (req) => {
      const body = await readJson(req);
      try {
        return await orchestrator.task({ taskType: body.taskType, prompt: body.prompt, system: body.system });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    },
  };

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
        const handler = api[`${req.method} ${url.pathname}`];
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
