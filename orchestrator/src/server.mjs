// HTTP API plus the WebUI's static files. Binds to loopback unless network access is switched on (see config/network.json).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { SCOPES } from './access.mjs';
import { isAffirmation } from './autoroute.mjs';
import { mediaIntent } from './media-intent.mjs';
import { checkMediaParams, MEDIA_FILE } from './connectors/comfy.mjs';
import { readdirSync, statSync } from 'node:fs';
import { basename as baseName } from 'node:path';

const MEDIA_TYPES = { mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

const MAX_BODY = 1_000_000;
const MAX_BODY_IMAGES = 40_000_000; // chat/task bodies may carry base64 images
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const LOOPBACK_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/;

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

async function readJson(req, max = MAX_BODY) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type must be application/json');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'Body is not valid JSON object');
  }
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

// Server-sent events over a POST response. The returned signal aborts when the run is cancelled explicitly
// (abort()), and also when the client disconnects unless `detach` is set. Chat and task runs are detached:
// a dropped browser connection must not throw away a model reply that is still being produced; the reply is
// saved to the conversation and the WebUI loads it. Shell and git streams are not detached.
function openStream(res, { detach = false } = {}) {
  res.on('error', () => {}); // a write after the socket died must not crash the service
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
  const ctrl = new AbortController();
  const live = () => !res.destroyed && !res.writableEnded;
  const write = (text) => {
    if (!live()) return;
    try { res.write(text); } catch { /* client gone; the run keeps going if detached */ }
  };
  if (!detach) {
    res.on('close', () => {
      if (!res.writableEnded) ctrl.abort();
    });
  }
  const ping = setInterval(() => write(': ping\n\n'), 15_000);
  ping.unref();
  return {
    signal: ctrl.signal,
    abort: () => ctrl.abort(),
    send: (obj) => write(`data: ${JSON.stringify(obj)}\n\n`),
    end() {
      clearInterval(ping);
      if (live()) res.end();
    },
  };
}

export function hostAllowed(host, network = {}) {
  if (LOOPBACK_HOSTS.test(host ?? '')) return true;
  const name = String(host ?? '').replace(/:\d+$/, '').toLowerCase();
  if ((network.allowedHosts ?? []).some((h) => h.toLowerCase() === name)) return true;
  // An IP literal can't be a DNS-rebinding name, so private-range IPs are safe to accept once LAN access is on.
  return !!network.allowPrivateIPs && PRIVATE_IPV4.test(name);
}

const OPEN = { id: 'open', name: 'open', scopes: new Set(SCOPES) };

// A request is "remote" if it did not come straight from this PC. Tailscale serve and other proxies connect from
// loopback, so forwarding headers also count.
export function isRemote(req) {
  const proxied = Object.keys(req.headers).some((k) => k.startsWith('x-forwarded-') || k.startsWith('tailscale-') || k === 'forwarded' || k === 'via');
  const addr = req.socket.remoteAddress ?? '';
  return proxied || !(addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

// saveConfig(kind, obj) persists an edit ('routes' | 'budgets'); status(config, opts) checks connector health.
// auth: createAuth(...) from access.mjs (scoped tokens). token: legacy single bearer token (tests). Neither: open.
export function createApp({ orchestrator, conversations, scheduler, jobs, grants, saveConfig, status, auth, token, attachments, memory, privateSessions, shell, terminals, github, connections, network = {}, webDir, mediaDir, version = '0.0.0', now = Date.now, tokenFile }) {
  const identify = auth
    ? (h) => auth.identify(h)
    : token
      ? (h) => {
          const got = Buffer.from((h ?? '').replace(/^Bearer\s+/i, ''));
          const want = Buffer.from(token);
          return got.length === want.length && timingSafeEqual(got, want) ? OPEN : null;
        }
      : () => OPEN;

  const need = (dep, name) => {
    if (!dep) throw new HttpError(404, `${name} is not enabled`);
    return dep;
  };
  const admin = (ctx) => {
    if (!ctx.identity.scopes.has('admin')) throw new HttpError(403, 'This needs the admin token');
  };

  // Shared by task and chat: stores images, and for agent routes checks admin rights and resolves the project folder.
  function prepare(ctx, body, effectiveType, convProject) {
    const images = body.images === undefined ? [] : need(attachments, 'Image attachments').saveAll(body.images);
    let cwd;
    let project;
    if (orchestrator.isAgentRoute(effectiveType)) {
      admin(ctx);
      project = body.project || convProject || undefined;
      cwd = need(shell, 'Shell access').resolveCwd({ project, cwd: body.cwd });
      project ??= shell.default;
    }
    return { images, cwd, project };
  }

  // Runs fn with an SSE stream when the body asks for one; otherwise returns fn's result as plain JSON.
  // Streams registered under body.runId (a client-made id) can be stopped with POST /api/runs/:id/cancel.
  const activeRuns = new Map();
  async function maybeStream(ctx, body, fn, { detach = false } = {}) {
    if (!body.stream) return fn({});
    const runId = typeof body.runId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.runId) ? body.runId : null;
    if (runId && activeRuns.has(runId)) throw new HttpError(409, 'A run with this id is already in progress');
    const s = openStream(ctx.res, { detach });
    ctx.streamed = true;
    if (runId) activeRuns.set(runId, s);
    s.send({ type: 'start' });
    try {
      s.send({ type: 'done', ...(await fn({ signal: s.signal, onEvent: s.send })) });
    } catch (err) {
      s.send({ type: 'error', error: err.message });
    } finally {
      if (runId) activeRuns.delete(runId);
    }
    s.end();
    return undefined;
  }

  const routes = [];
  const add = (method, path, scope, handler) => {
    const names = [];
    const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)'))}$`);
    routes.push({ method, re, names, scope, handler });
  };

  // ---- public-ish ----
  add('GET', '/api/health', null, () => ({ ok: true, version }));
  add('GET', '/api/whoami', 'any', (c) => ({ id: c.identity.id, name: c.identity.name, scopes: [...c.identity.scopes] }));

  // ---- read ----
  add('GET', '/api/config', 'read', () => {
    const { connectors, routes: r, default: def, auto } = orchestrator.config;
    return { connectors, routes: r, default: def, auto, caps: orchestrator.caps, editable: !!saveConfig, features: { usageReset: true, private: !!privateSessions, shell: !!shell, terminals: !!terminals, memory: !!memory, github: !!github, images: !!attachments, devices: !!auth, connections: !!connections, scheduler: !!scheduler, jobs: !!jobs, access: !!grants } };
  });
  add('GET', '/api/usage', 'read', (c) => {
    const hours = Number(c.url.searchParams.get('hours') ?? 24);
    if (!Number.isFinite(hours) || hours <= 0) throw new HttpError(400, 'hours must be a positive number');
    return { hours, ...orchestrator.usage(now() - hours * 3_600_000), caps: orchestrator.capStatus(), window: orchestrator.budgetWindow() };
  });
  add('POST', '/api/usage/reset', 'admin', () => orchestrator.clearUsage());
  add('GET', '/api/status', 'read', async (c) => need(status, 'Status checks')(orchestrator.config, { fresh: c.url.searchParams.get('fresh') === '1' }));
  add('GET', '/api/history', 'read', (c) => {
    const limit = Number(c.url.searchParams.get('limit') ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, 'limit must be 1-1000');
    return { tasks: orchestrator.history?.list(limit) ?? [] };
  });
  add('GET', '/api/schedule', 'read', () => ({ ...need(scheduler, 'Scheduler').list(), queue: orchestrator.queue() }));
  add('GET', '/api/conversations', 'read', (c) => {
    const state = c.url.searchParams.get('state') ?? 'active';
    if (!['active', 'archived', 'trash'].includes(state)) throw new HttpError(400, 'state must be active, archived or trash');
    return { state, conversations: need(conversations, 'Chat').list(state) };
  });
  add('GET', '/api/conversations/:id', 'read', (c) => userCall(() => need(conversations, 'Chat').get(c.params.id) ?? Promise.reject(new Error('Conversation not found'))));
  add('GET', '/api/projects', 'read', () => ({ default: need(shell, 'Shell access').default, projects: shell.projects() }));
  add('GET', '/api/memory', 'read', (c) => {
    const m = need(memory, 'Memory');
    const q = c.url.searchParams.get('q');
    return { notes: q ? m.search(q, 20) : m.list() };
  });
  add('GET', '/api/memory/mcl', 'read', (c) => {
    const m = need(memory, 'Memory');
    return { ...m.exportMcl({ alias: c.url.searchParams.get('alias') !== '0' }) };
  });
  add('GET', '/api/memory/context', 'read', async (c) => {
    const q = c.url.searchParams.get('q') ?? '';
    const maxChars = Number(c.url.searchParams.get('maxChars') ?? 1800);
    if (q.length > 4000 || !Number.isInteger(maxChars) || maxChars < 400 || maxChars > 12000) throw new HttpError(400, 'Query must be at most 4000 characters; maxChars must be an integer 400-12000');
    const text = await need(memory, 'Memory').contextAsync(q, { format: 'mcl', maxChars, limit: 12 });
    return { text, chars: text.length, maxChars, format: 'mcl', unverified: true };
  });
  add('GET', '/api/connections', 'read', () => ({ connections: need(connections, 'Connections').list() }));
  add('GET', '/api/github', 'read', (c) => userCall(() => need(github, 'GitHub').summary()));
  add('GET', '/api/github/issues', 'read', (c) => userCall(async () => ({ issues: await need(github, 'GitHub').issues(c.url.searchParams.get('state') ?? 'open') })));
  add('GET', '/api/github/runs', 'read', (c) => userCall(async () => ({ runs: await need(github, 'GitHub').runs() })));

  // ---- background jobs: queue work and walk away ----
  add('GET', '/api/jobs', 'read', () => ({ jobs: need(jobs, 'Jobs').list(), ...jobs.stats() }));
  add('GET', '/api/jobs/:id', 'read', (c) => userCall(() => need(jobs, 'Jobs').get(c.params.id)));
  add('POST', '/api/jobs', 'admin', async (c) => {
    const body = await readJson(c.req);
    const q = need(jobs, 'Jobs');
    return userCall(() => {
      // A job on an agent route needs a project folder; default to the configured default so "just queue it" works.
      const fill = (s) => ({ ...s, project: s?.project || (shell?.default ?? undefined) });
      if (Array.isArray(body.jobs)) return { results: q.addMany(body.jobs.map(fill)) };
      return q.add(fill(body));
    });
  });
  add('POST', '/api/jobs/clear', 'admin', () => need(jobs, 'Jobs').clearFinished());
  add('POST', '/api/jobs/pause', 'admin', () => (need(jobs, 'Jobs').pause(), jobs.stats()));
  add('POST', '/api/jobs/resume', 'admin', () => (need(jobs, 'Jobs').resume(), jobs.stats()));
  add('POST', '/api/jobs/:id/cancel', 'admin', (c) => userCall(() => need(jobs, 'Jobs').cancel(c.params.id)));
  // Notes on a job's ongoing thought process. apply:true also cuts a running job short (or re-queues a finished one) so the note takes effect now.
  add('POST', '/api/jobs/:id/notes', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(jobs, 'Jobs').addNote(c.params.id, body.text, { apply: !!body.apply }));
  });
  // The answer to a folder-access request: once | always | deny.
  add('POST', '/api/jobs/:id/access', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(jobs, 'Jobs').resolveAccess(c.params.id, body.decision));
  });
  // Standing folder permissions (beyond project folders) for agent runs.
  add('GET', '/api/access', 'admin', () => ({ folders: need(grants, 'Access grants').list() }));
  add('POST', '/api/access', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(grants, 'Access grants').add({ path: body.path, write: body.write !== false, note: body.note }));
  });
  add('DELETE', '/api/access/:id', 'admin', (c) => userCall(() => (need(grants, 'Access grants').remove(c.params.id), { ok: true })));
  add('POST', '/api/jobs/:id/retry', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(jobs, 'Jobs').retry(c.params.id, body.guidance));
  });

  // ---- chat ----
  add('POST', '/api/task', 'chat', async (c) => {
    const body = await readJson(c.req, MAX_BODY_IMAGES);
    const { images, cwd } = await userCall(() => prepare(c, body, body.taskType));
    // Media settings are checked here so a bad value is an HTTP 400, not a failed run.
    const params = body.params === undefined ? undefined : checkMediaParams(body.params, { where: 'params' });
    return maybeStream(c, body, (extra) => userCall(() => orchestrator.task({ taskType: body.taskType, prompt: body.prompt, system: body.system, connector: body.connector, params, images, cwd, ...extra })), { detach: true });
  });
  // Explicit Stop: the only thing that aborts a detached chat/task run.
  add('POST', '/api/runs/:id/cancel', 'chat', async (c) => {
    const run = activeRuns.get(c.params.id);
    if (!run) throw new HttpError(404, 'No active run with that id (it may have finished)');
    run.abort();
    return { ok: true, cancelled: c.params.id };
  });
  // Where did a request id end up? Lets a client that lost the stream before the conversation id arrived find its chat.
  add('GET', '/api/runs/:id', 'chat', (c) => {
    const found = need(conversations, 'Chat').findByRun(c.params.id);
    if (!found) throw new HttpError(404, 'No saved request with that id');
    return { ...found, active: activeRuns.has(c.params.id) };
  });
  add('POST', '/api/chat', 'chat', async (c) => {
    const body = await readJson(c.req, MAX_BODY_IMAGES);
    const conv = body.conversationId && conversations ? conversations.get(body.conversationId) : null;
    // Approving a plan runs it on the planning route's `then` route, in the folder that was planned.
    let approval = body.approve ? orchestrator.approvalFor(body.conversationId) : null;
    if (body.approve && !approval) throw new HttpError(400, 'There is no plan waiting for approval in this conversation');
    if (approval && body.images !== undefined) throw new HttpError(400, 'Images cannot be attached to a plan approval');
    // Auto chats: a cheap check on every message picks the route. "Yes, go ahead" under a pending plan approves it.
    const isAuto = !body.approve && !!orchestrator.config.auto && (body.taskType === 'auto' || (!body.taskType && conv?.taskType === 'auto'));
    const canAct = c.identity.scopes.has('admin') && !!shell;
    let pendingAuto = null;
    if (isAuto) {
      const pending = orchestrator.approvalFor(body.conversationId);
      if (pending && canAct && body.images === undefined && isAffirmation(body.prompt)) {
        approval = pending;
        pendingAuto = { kind: 'approve', route: pending.route, via: 'rule', reason: 'go-ahead on a pending plan', ms: 0 };
      }
    }
    // Without a per-message check the route is known now, so permission and project errors return as HTTP errors.
    const cfg = orchestrator.config;
    const explicitMedia = !isAuto && !!body.connector && !!body.taskType && cfg.connectors[body.connector]?.kind === 'comfyui' && cfg.routes[body.taskType]?.chain.includes(body.connector);
    const media = !approval && !explicitMedia && mediaIntent(body.prompt, cfg);
    const params = body.params === undefined ? undefined : await userCall(() => checkMediaParams(body.params));
    const early = isAuto && !pendingAuto ? null : await userCall(() => approval
      ? prepare(c, { project: approval.project }, approval.route, conv?.project)
      : prepare(c, body, media?.route || body.taskType || conv?.taskType, conv?.project));
    return maybeStream(c, body, (extra) => userCall(async () => {
      let auto = pendingAuto;
      if (isAuto && !auto) {
        extra.onEvent?.({ type: 'routing' });
        auto = await orchestrator.autoRoute({ conversationId: body.conversationId, prompt: body.prompt, hasImages: Array.isArray(body.images) && body.images.length > 0, canAct, signal: extra.signal });
      }
      if (auto) extra.onEvent?.({ type: 'routed', ...auto });
      const { images, cwd, project } = early ?? prepare(c, body, auto.route, conv?.project);
      const reply = await orchestrator.chat({
        conversationId: body.conversationId, prompt: approval && pendingAuto ? undefined : body.prompt, taskType: auto ? undefined : body.taskType, connector: body.connector,
        images, cwd, project, params, runId:body.runId, approve: !!approval, auto: approval ? undefined : auto ?? undefined, ...extra,
      });
      return pendingAuto ? { ...reply, reply: { ...reply.reply, auto: { via: pendingAuto.via, reason: pendingAuto.reason, ms: 0 } } } : reply;
    }), { detach: true });
  });
  // ---- private chat: in-memory transcript + scratch folder, local models only, wiped on close (see private.mjs) ----
  const priv = (c) => {
    const s = need(privateSessions, 'Private chat').get(c.params.id);
    if (!s) throw new HttpError(404, 'This private chat is closed');
    return s;
  };
  add('POST', '/api/private', 'chat', () => {
    const s = need(privateSessions, 'Private chat').create();
    return { id: s.id, idleMinutes: Math.round(privateSessions.ttlMs / 60_000) };
  });
  add('POST', '/api/private/:id/chat', 'chat', async (c) => {
    const s = priv(c);
    const body = await readJson(c.req, MAX_BODY_IMAGES);
    if (s.abort) throw new HttpError(409, 'This private chat is still answering');
    const params = body.params === undefined ? undefined : await userCall(() => checkMediaParams(body.params));
    const images = body.images === undefined ? [] : await userCall(() => s.images().saveAll(body.images));
    return maybeStream(c, body, (extra) => userCall(async () => {
      // One request at a time per session; Stop (or closing the chat) aborts it.
      const ctrl = new AbortController();
      s.abort = ctrl;
      const onAbort = () => ctrl.abort();
      extra.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const out = await orchestrator.privateChat(s, { prompt: body.prompt, taskType: body.taskType, connector: body.connector, params, images, signal: ctrl.signal, onEvent: extra.onEvent });
        return out;
      } finally {
        extra.signal?.removeEventListener('abort', onAbort);
        s.abort = null;
      }
    }), { detach: false });
  });
  add('GET', '/api/private/:id/media/:name', 'chat', (c) => {
    const s = priv(c);
    const name = c.params.name;
    const type = MEDIA_TYPES[(name.split('.').pop() ?? '').toLowerCase()];
    if (!MEDIA_FILE.test(name) || baseName(name) !== name || !type) throw new HttpError(404, 'Media file not found');
    let body;
    try { body = readFileSync(join(s.mediaDir, name)); } catch { throw new HttpError(404, 'Media file not found'); }
    c.res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    c.res.end(body);
    c.streamed = true;
  });
  add('GET', '/api/private/:id/attachments/:att', 'chat', async (c) => {
    const s = priv(c);
    const f = await userCall(() => s.images().file(c.params.att));
    if (!f) throw new HttpError(404, 'Attachment not found');
    c.res.writeHead(200, { 'content-type': f.mediaType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    c.res.end(readFileSync(f.path));
    c.streamed = true;
  });
  const closePrivate = (c) => ({ ok: true, closed: need(privateSessions, 'Private chat').close(c.params.id) });
  add('DELETE', '/api/private/:id', 'chat', closePrivate);
  add('POST', '/api/private/:id/close', 'chat', closePrivate);
  add('PATCH', '/api/conversations/:id', 'chat', async (c) => {
    const body = await readJson(c.req);
    if (typeof body.title !== 'string' || !body.title.trim()) throw new HttpError(400, 'title must be a non-empty string');
    return userCall(() => need(conversations, 'Chat').rename(c.params.id, body.title.trim()));
  });
  add('POST', '/api/conversations/:id/notes', 'chat', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => ({ notes: need(conversations, 'Chat').addNote(c.params.id, body.text) }));
  });
  add('DELETE', '/api/conversations/:id/notes/:noteId', 'chat', (c) => userCall(() => ({ notes: need(conversations, 'Chat').removeNote(c.params.id, c.params.noteId) })));
  add('DELETE', '/api/conversations/:id', 'chat', (c) => userCall(() => (need(conversations, 'Chat').archive(c.params.id), { ok: true, archived: c.params.id })));
  // Delete = move to data/conversations/trash (restorable). Restore works from archive or trash.
  add('POST', '/api/conversations/:id/trash', 'chat', (c) => userCall(() => (need(conversations, 'Chat').trash(c.params.id), { ok: true, trashed: c.params.id })));
  add('POST', '/api/conversations/:id/restore', 'chat', (c) => userCall(() => ({ ok: true, conversation: need(conversations, 'Chat').restore(c.params.id) })));
  // Generated media (video, music, images) that ComfyUI wrote into data/media. Names only; no paths leave the server.
  add('GET', '/api/media', 'read', () => {
    if (!mediaDir) return { files: [] };
    let names = [];
    try { names = readdirSync(mediaDir); } catch { /* folder not created yet */ }
    const files = names.filter((n) => MEDIA_FILE.test(n)).map((name) => {
      const st = statSync(join(mediaDir, name));
      return { name, size: st.size, ts: st.mtimeMs, type: MEDIA_TYPES[name.split('.').pop().toLowerCase()] ?? 'application/octet-stream' };
    }).filter((f) => f.size > 0).sort((a, b) => b.ts - a.ts).slice(0, 200);
    return { files };
  });
  add('GET', '/api/media/:name', 'read', (c) => {
    const name = c.params.name;
    const type = MEDIA_TYPES[(name.split('.').pop() ?? '').toLowerCase()];
    if (!mediaDir || !MEDIA_FILE.test(name) || baseName(name) !== name || !type) throw new HttpError(404, 'Media file not found');
    let body;
    try { body = readFileSync(join(mediaDir, name)); } catch { throw new HttpError(404, 'Media file not found'); }
    c.res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    c.res.end(body);
    c.streamed = true;
  });
  add('GET', '/api/attachments/:id', 'read', async (c) => {
    const f = await userCall(() => need(attachments, 'Image attachments').file(c.params.id));
    if (!f) throw new HttpError(404, 'Attachment not found');
    c.res.writeHead(200, { 'content-type': f.mediaType, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    c.res.end(readFileSync(f.path));
    c.streamed = true;
  });

  // ---- admin ----
  add('PUT', '/api/config/routes', 'admin', async (c) => {
    if (!saveConfig) throw new HttpError(404, 'Config editing is not enabled');
    const body = await readJson(c.req);
    await userCall(() => orchestrator.setConfig(body));
    saveConfig('routes', body);
    return { ok: true };
  });
  add('PUT', '/api/config/budgets', 'admin', async (c) => {
    if (!saveConfig) throw new HttpError(404, 'Config editing is not enabled');
    const body = await readJson(c.req);
    await userCall(() => orchestrator.setCaps(body));
    saveConfig('budgets', body);
    return { ok: true };
  });
  add('POST', '/api/schedule/run', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(scheduler, 'Scheduler').runNow(body.name));
  });

  add('POST', '/api/memory', 'admin', async (c) => userCall(async () => need(memory, 'Memory').add(await readJson(c.req))));
  add('POST', '/api/memory/mcl', 'admin', async (c) => userCall(async () => {
    const body = await readJson(c.req);
    if (typeof body?.text !== 'string') throw new Error('text (MCL) is required');
    return need(memory, 'Memory').importMcl(body.text);
  }));
  add('PATCH', '/api/memory/:id', 'admin', async (c) => userCall(async () => need(memory, 'Memory').update(c.params.id, await readJson(c.req))));
  add('DELETE', '/api/memory/:id', 'admin', (c) => userCall(() => (need(memory, 'Memory').remove(c.params.id), { ok: true, trashed: c.params.id })));

  add('POST', '/api/exec', 'admin', async (c) => {
    const body = await readJson(c.req);
    const sh = need(shell, 'Shell access');
    return maybeStream(c, body, (extra) => userCall(() => sh.exec({ command: body.command, project: body.project, cwd: body.cwd, timeoutMs: body.timeoutMs, who: c.identity.id, signal: extra.signal, onData: extra.onEvent && ((d) => extra.onEvent({ type: d.stream, text: d.text })) })));
  });
  // ---- interactive terminals: long-lived shells; output streams over SSE and can be re-attached with ?since=<seq> ----
  add('GET', '/api/terminal', 'admin', () => ({ sessions: need(terminals, 'Terminals').list(), default: shell?.projects().find((p) => p.name === shell.default)?.path }));
  add('POST', '/api/terminal', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(terminals, 'Terminals').create({ cwd: body.cwd, shell: body.shell, who: c.identity.id }));
  });
  add('GET', '/api/terminal/:id/stream', 'admin', async (c) => {
    const t = need(terminals, 'Terminals');
    const since = Number(c.url.searchParams.get('since') ?? 0);
    const s = openStream(c.res);
    c.streamed = true;
    let off = () => {};
    try {
      off = await userCall(() => t.subscribe(c.params.id, Number.isFinite(since) ? since : 0, (ev) => {
        s.send(ev);
        if (ev.type === 'exit' && ev.closed) s.end();
      }));
    } catch (err) {
      s.send({ type: 'error', error: err.message });
      return s.end();
    }
    c.res.on('close', off);
    return undefined;
  });
  add('POST', '/api/terminal/:id/input', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(terminals, 'Terminals').input(c.params.id, body.data, { run: !!body.run, who: c.identity.id }));
  });
  add('POST', '/api/terminal/:id/interrupt', 'admin', (c) => userCall(() => need(terminals, 'Terminals').interrupt(c.params.id, { who: c.identity.id })));
  add('DELETE', '/api/terminal/:id', 'admin', (c) => userCall(() => need(terminals, 'Terminals').close(c.params.id, { who: c.identity.id })));

  add('POST', '/api/projects/:name/test', 'admin', async (c) => {
    const body = await readJson(c.req);
    const sh = need(shell, 'Shell access');
    return maybeStream(c, body, (extra) => userCall(() => sh.test(c.params.name, { who: c.identity.id, signal: extra.signal, onData: extra.onEvent && ((d) => extra.onEvent({ type: d.stream, text: d.text })) })));
  });
  add('POST', '/api/projects/:name/git', 'admin', async (c) => {
    const body = await readJson(c.req);
    const sh = need(shell, 'Shell access');
    return maybeStream(c, body, (extra) => userCall(() => sh.git(c.params.name, body.action, { message: body.message, who: c.identity.id, signal: extra.signal, onData: extra.onEvent && ((d) => extra.onEvent({ type: d.stream, text: d.text })) })));
  });
  add('POST', '/api/github/issues', 'admin', async (c) => userCall(async () => need(github, 'GitHub').createIssue(await readJson(c.req))));
  add('POST', '/api/github/comment', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(github, 'GitHub').comment(body.number, body.body));
  });

  add('POST', '/api/connections/github/device', 'admin', (c) => userCall(() => need(connections, 'Connections').deviceStart()));
  add('POST', '/api/connections/github/device/poll', 'admin', (c) => userCall(() => need(connections, 'Connections').devicePoll()));
  add('POST', '/api/connections/:id', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(connections, 'Connections').connect(c.params.id, body.secret));
  });
  add('DELETE', '/api/connections/:id', 'admin', (c) => userCall(() => need(connections, 'Connections').disconnect(c.params.id)));

  add('GET', '/api/devices', 'admin', () => ({ devices: need(auth, 'Device tokens').listDevices(), scopes: SCOPES }));
  add('POST', '/api/devices', 'admin', async (c) => {
    const body = await readJson(c.req);
    return userCall(() => need(auth, 'Device tokens').addDevice({ name: body.name, scopes: body.scopes })); // plain token is returned once
  });
  add('DELETE', '/api/devices/:id', 'admin', (c) => userCall(() => (need(auth, 'Device tokens').removeDevice(c.params.id), { ok: true })));

  // The WebUI on this PC fetches the admin token here so you aren't asked to paste it. Refused for anything that
  // arrived through a proxy (Tailscale serve, LAN), for non-loopback hosts, and for cross-site browser requests.
  function bootstrap(req) {
    const site = req.headers['sec-fetch-site'];
    if (!tokenFile || !LOOPBACK_HOSTS.test(req.headers.host ?? '') || isRemote(req) || (site && site !== 'same-origin' && site !== 'none')) throw new HttpError(403, 'Token bootstrap is only available to the WebUI on this PC');
    return { token: readFileSync(tokenFile, 'utf8').trim() };
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
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'" });
    res.end(data);
  }

  return async function handle(req, res) {
    try {
      // Rejecting foreign Host headers blocks DNS-rebinding pages from reaching the API.
      if (!hostAllowed(req.headers.host, network)) throw new HttpError(421, 'Unexpected Host header');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/bootstrap' && req.method === 'GET') return send(res, 200, bootstrap(req));
        let match = null;
        let params = {};
        let pathKnown = false;
        for (const r of routes) {
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          pathKnown = true;
          if (r.method !== req.method) continue;
          match = r;
          params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
          break;
        }
        if (!match) throw new HttpError(pathKnown ? 405 : 404, pathKnown ? 'Method not allowed' : 'Unknown endpoint');
        let identity = null;
        if (match.scope !== null) {
          identity = identify(req.headers.authorization);
          if (!identity) throw new HttpError(401, 'Missing or wrong bearer token');
          // Shell, agents, config and devices stay on this PC unless network.remoteAdmin is switched on.
          if (!network.remoteAdmin && identity.scopes.has('admin') && isRemote(req)) identity = { ...identity, scopes: new Set(['read', 'chat']) };
          if (match.scope !== 'any' && !identity.scopes.has(match.scope)) throw new HttpError(403, `This needs the "${match.scope}" scope`);
        }
        const ctx = { req, res, url, params, identity, streamed: false };
        const result = await match.handler(ctx);
        if (!ctx.streamed) send(res, 200, result);
        return undefined;
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
