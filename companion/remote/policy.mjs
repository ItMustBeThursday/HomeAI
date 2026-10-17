// Pure policy helpers for the HomeAI remote companion bridge.
// No sockets, timers or I/O: every function here is deterministic so it can be unit-tested with node:test.
import crypto from 'node:crypto';

export const PROTOCOL_VERSION = 4;
export const LISTEN_HOST = '127.0.0.1';
export const LISTEN_PORT = 18896;
export const UPSTREAM_URL = 'ws://127.0.0.1:18795';
export const HEALTH_PATH = '/health';
export const COMPANION_PATH = '/companion';
// RFC 5737 documentation address sent upstream as X-Forwarded-For so the Gateway never treats a
// bridged internet client as a trusted local loopback connection. It is a marker, not an identity.
export const REMOTE_MARKER_IP = '192.0.2.1';

export const LIMITS = Object.freeze({
  maxClientFrameBytes: 8 * 1024 * 1024,
  maxUpstreamFrameBytes: 32 * 1024 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxConnections: 16,
  maxUnauthenticated: 8,
  handshakeTimeoutMs: 15_000,
  upstreamOpenTimeoutMs: 5_000,
  maxPendingRequests: 64,
  rateCapacity: 40,
  rateRefillPerSec: 10,
  maxRateStrikes: 20,
  pingIntervalMs: 30_000,
  maxIdLength: 128,
});

export const OPERATOR_SCOPES = Object.freeze(['operator.read', 'operator.write', 'operator.approvals']);
// Gateway limited mobile setup also grants questions/talk-secret scopes. No matching
// RPCs are exposed here; only the closed non-admin profile may cross the handoff.
const BOOTSTRAP_HANDOFF_SCOPES = [...OPERATOR_SCOPES, 'operator.questions', 'operator.talk.secrets'];
export const ALLOWED_CLIENT_IDS = Object.freeze(['webchat', 'openclaw-android']);
export const ALLOWED_CAPS = Object.freeze(['tool-events']);
export const ALLOWED_EVENTS = Object.freeze(['chat', 'agent', 'sessions.changed', 'heartbeat', 'tick']);
export const ALLOWED_AGENT_STREAMS = Object.freeze(['tool', 'lifecycle']);
export const SESSION_PATCH_KEYS = Object.freeze(['key', 'label', 'model', 'thinkingLevel']);

/** Allowlisted post-auth methods and the only param keys each may carry (from docs/SPEC.md + gateway-client.mjs). */
export const METHOD_PARAM_KEYS = Object.freeze({
  'sessions.list': Object.freeze(['limit', 'offset', 'search', 'includeDerivedTitles', 'includeLastMessage',
    'excludeCron', 'excludeSystem', 'excludeSubagents', 'sortBy']),
  'sessions.search': Object.freeze(['query', 'limit']),
  'chat.history': Object.freeze(['sessionKey', 'limit']),
  'chat.send': Object.freeze(['sessionKey', 'message', 'idempotencyKey', 'attachments', 'thinking', 'queueMode']),
  'chat.abort': Object.freeze(['sessionKey', 'runId']),
  'sessions.patch': SESSION_PATCH_KEYS,
  'sessions.delete': Object.freeze(['key']),
  'models.list': Object.freeze([]),
  'agents.list': Object.freeze([]),
  'sessions.subscribe': Object.freeze([]),
});
export const ALLOWED_METHODS = Object.freeze(['connect', ...Object.keys(METHOD_PARAM_KEYS)]);

const CONNECT_KEYS = ['minProtocol', 'maxProtocol', 'client', 'role', 'scopes', 'caps', 'commands', 'permissions',
  'auth', 'locale', 'userAgent', 'device'];
const CLIENT_KEYS = ['id', 'version', 'platform', 'mode', 'deviceFamily', 'displayName', 'modelIdentifier', 'instanceId'];
const DEVICE_KEYS = ['id', 'publicKey', 'signature', 'signedAt', 'nonce'];
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TEXT_HEADERS = Object.freeze({
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

// ---- Generic value checks ----

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const hasOnlyKeys = (obj, allowed) => Object.keys(obj).every((k) => allowed.includes(k));
const hasExactKeys = (obj, keys) => Object.keys(obj).length === keys.length && keys.every((k) => Object.hasOwn(obj, k));

export function isShortString(v, max, { allowEmpty = false } = {}) {
  return typeof v === 'string' && (allowEmpty || v.length > 0) && v.length <= max && !CONTROL_CHARS.test(v);
}

const isToken = (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096 && /^[\x21-\x7e]+$/.test(v);

function decodeBase64Url(v, bytes) {
  if (typeof v !== 'string' || v.length > 128 || !BASE64URL.test(v)) return null;
  const buf = Buffer.from(v, 'base64url');
  return buf.length === bytes && buf.toString('base64url') === v ? buf : null;
}

const isScopeList = (list, allowed) => Array.isArray(list) && list.every((s) => typeof s === 'string' && allowed.includes(s));

/** Request ids: printable ASCII strings up to 128 chars, or non-negative safe integers. */
export function isValidId(id) {
  if (typeof id === 'string') return id.length > 0 && id.length <= LIMITS.maxIdLength && /^[\x21-\x7e]+$/.test(id);
  return Number.isSafeInteger(id) && id >= 0;
}

export const idKey = (id) => `${typeof id}:${id}`;

/** WebSocket close reasons must be <= 123 bytes; keep them printable ASCII. */
export function closeReason(reason) {
  return String(reason ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 120);
}

export function denyFrame(id, code, message) {
  return { type: 'res', id, ok: false, error: { code, message } };
}

// ---- HTTP surface ----

/** Only GET/HEAD /health is served over plain HTTP; everything else is 404/405. */
export function routeHttp(method, url) {
  if (url !== HEALTH_PATH) return { status: 404, headers: TEXT_HEADERS, body: 'not found\n' };
  if (method !== 'GET' && method !== 'HEAD') {
    return { status: 405, headers: { ...TEXT_HEADERS, allow: 'GET, HEAD' }, body: 'method not allowed\n' };
  }
  return { status: 200, headers: TEXT_HEADERS, body: 'ok\n' };
}

/** Upgrade gate: exact /companion path, no browser Origin, bounded total and unauthenticated connections. */
export function checkUpgrade({ method, url, headers = {} }, counts) {
  if (method !== 'GET') return { ok: false, status: 405, reason: 'method not allowed' };
  if (url !== COMPANION_PATH) return { ok: false, status: 404, reason: 'unknown path' };
  if (String(headers.upgrade ?? '').toLowerCase() !== 'websocket') return { ok: false, status: 400, reason: 'not a websocket upgrade' };
  if (headers.origin !== undefined) return { ok: false, status: 403, reason: 'browser origins are not allowed' };
  if (counts.total >= LIMITS.maxConnections) return { ok: false, status: 503, reason: 'connection limit reached' };
  if (counts.unauthenticated >= LIMITS.maxUnauthenticated) return { ok: false, status: 503, reason: 'handshake limit reached' };
  return { ok: true };
}

/**
 * Headers for the upstream Gateway connection. Built from scratch: no client header (X-Forwarded-*,
 * Tailscale-User-*, Origin, Authorization, Cookie, ...) is ever copied, and no credential is added.
 */
export function buildUpstreamHeaders() {
  return { 'x-forwarded-for': REMOTE_MARKER_IP };
}

// ---- Per-connection state ----

/** phase: awaiting-challenge -> challenged -> connecting -> authenticated (or closed). */
export function createSession() {
  return { phase: 'awaiting-challenge', challenge: null, requestedRole: null, requestedScopes: null, role: null, pending: new Map() };
}

/** Token bucket; `now` is passed in so the limiter stays deterministic. */
export function createRateLimiter({ capacity, refillPerSec }, nowMs) {
  let tokens = capacity;
  let last = nowMs;
  return {
    take(now) {
      tokens = Math.min(capacity, tokens + (Math.max(0, now - last) / 1000) * refillPerSec);
      last = Math.max(last, now);
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

// ---- Frame parsing ----

function byteSize(data) {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((n, b) => n + (Buffer.isBuffer(b) ? b.length : Infinity), 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return Infinity;
}

function toText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return null;
}

function parseJson(data, isBinary, maxBytes) {
  if (isBinary) return { ok: false, reason: 'binary frames are not accepted' };
  if (byteSize(data) > maxBytes) return { ok: false, reason: 'frame too large' };
  const text = toText(data);
  if (text === null) return { ok: false, reason: 'unsupported frame data' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'malformed JSON' };
  }
}

/** Client frames must be `{type:"req", id, method, params?}` text JSON within the size limit. */
export function parseClientFrame(data, isBinary, maxBytes = LIMITS.maxClientFrameBytes) {
  const r = parseJson(data, isBinary, maxBytes);
  if (!r.ok) return r;
  const f = r.value;
  if (!isPlainObject(f) || f.type !== 'req') return { ok: false, reason: 'only req frames are accepted' };
  if (!hasOnlyKeys(f, ['type', 'id', 'method', 'params'])) return { ok: false, reason: 'unexpected frame fields' };
  if (!isValidId(f.id)) return { ok: false, reason: 'invalid request id' };
  if (!isShortString(f.method, 64)) return { ok: false, reason: 'invalid method' };
  const params = f.params === undefined ? {} : f.params;
  if (!isPlainObject(params)) return { ok: false, reason: 'params must be an object' };
  return { ok: true, frame: { type: 'req', id: f.id, method: f.method, params } };
}

export function parseUpstreamFrame(data, isBinary, maxBytes = LIMITS.maxUpstreamFrameBytes) {
  const r = parseJson(data, isBinary, maxBytes);
  if (!r.ok) return r;
  const f = r.value;
  if (!isPlainObject(f)) return { ok: false, reason: 'frame is not an object' };
  if (f.type === 'res' && (!isValidId(f.id) || typeof f.ok !== 'boolean')) return { ok: false, reason: 'malformed response' };
  if (f.type === 'event' && !isShortString(f.event, 128)) return { ok: false, reason: 'malformed event' };
  return { ok: true, frame: f };
}

// ---- Request policy ----

/**
 * Validates a client `connect` against the observed upstream challenge. The signed device handshake is
 * passed through unchanged (end to end); the bridge only narrows what may be requested.
 * Allowed: role operator with read/write/approvals scopes and a token, or role node with no scopes and a
 * bootstrap token (setup-code pairing). Never admin, never commands/permissions, device identity required.
 */
export function validateConnectParams(params, challenge) {
  const fail = (reason) => ({ ok: false, reason });
  if (!challenge) return fail('no challenge issued');
  if (!isPlainObject(params) || !hasOnlyKeys(params, CONNECT_KEYS)) return fail('unexpected connect fields');
  const { minProtocol, maxProtocol } = params;
  if (!Number.isInteger(minProtocol) || !Number.isInteger(maxProtocol)
    || minProtocol > PROTOCOL_VERSION || maxProtocol < PROTOCOL_VERSION) return fail('unsupported protocol range');

  const c = params.client;
  if (!isPlainObject(c) || !hasOnlyKeys(c, CLIENT_KEYS)) return fail('invalid client');
  if (!ALLOWED_CLIENT_IDS.includes(c.id)) return fail('client id not allowed');
  if (!isShortString(c.version, 64) || !isShortString(c.platform, 64)) return fail('invalid client');
  for (const k of ['deviceFamily', 'displayName', 'modelIdentifier', 'instanceId']) {
    if (c[k] !== undefined && !isShortString(c[k], 128)) return fail('invalid client');
  }

  const { role, scopes, auth } = params;
  if (!Array.isArray(scopes)) return fail('scopes must be an array');
  if (scopes.includes('operator.admin')) return fail('admin scope is not allowed');
  if (scopes.length > OPERATOR_SCOPES.length || new Set(scopes).size !== scopes.length) return fail('invalid scopes');
  if (!isPlainObject(auth)) return fail('auth required');
  if (role === 'operator') {
    if (c.mode !== 'ui') return fail('operator clients must use ui mode');
    if (scopes.length === 0 || !isScopeList(scopes, OPERATOR_SCOPES)) return fail('scope not allowed');
    if (!(hasExactKeys(auth, ['token']) && isToken(auth.token))
      && !(hasExactKeys(auth, ['bootstrapToken']) && isToken(auth.bootstrapToken))) return fail('operator auth must be a single token');
  } else if (role === 'node') {
    if (c.mode !== 'node') return fail('bootstrap pairing must use node mode');
    if (scopes.length !== 0) return fail('bootstrap pairing must request no scopes');
    if (!hasExactKeys(auth, ['bootstrapToken']) || !isToken(auth.bootstrapToken)) {
      return fail('node role is only allowed for bootstrap pairing');
    }
  } else {
    return fail('role not allowed');
  }

  if (params.commands !== undefined && !(Array.isArray(params.commands) && params.commands.length === 0)) {
    return fail('commands are not allowed');
  }
  if (params.permissions !== undefined && !(isPlainObject(params.permissions) && Object.keys(params.permissions).length === 0)) {
    return fail('permissions are not allowed');
  }
  if (params.caps !== undefined && !(isScopeList(params.caps, ALLOWED_CAPS) && params.caps.length <= ALLOWED_CAPS.length)) {
    return fail('capability not allowed');
  }
  if (params.locale !== undefined && !(typeof params.locale === 'string' && /^[A-Za-z0-9_-]{1,35}$/.test(params.locale))) {
    return fail('invalid locale');
  }
  if (params.userAgent !== undefined && !isShortString(params.userAgent, 200)) return fail('invalid userAgent');

  const d = params.device;
  if (!isPlainObject(d) || !hasExactKeys(d, DEVICE_KEYS)) return fail('device identity required');
  if (typeof d.id !== 'string' || !/^[0-9a-f]{64}$/.test(d.id)) return fail('invalid device id');
  const pub = decodeBase64Url(d.publicKey, 32);
  if (!pub || crypto.createHash('sha256').update(pub).digest('hex') !== d.id) return fail('device id does not match public key');
  if (!decodeBase64Url(d.signature, 64)) return fail('invalid device signature encoding');
  if (d.nonce !== challenge.nonce || d.signedAt !== challenge.ts) return fail('device signature is not bound to this challenge');

  return { ok: true, role, scopes: [...scopes], params: structuredClone(params) };
}

export function validateSessionPatch(params) {
  const fail = (message) => ({ ok: false, code: 'PARAM_NOT_ALLOWED', message });
  if (!isPlainObject(params) || !hasOnlyKeys(params, SESSION_PATCH_KEYS)) {
    return fail('sessions.patch may only change label, model or thinkingLevel.');
  }
  if (!isShortString(params.key, 512)) return fail('sessions.patch requires a session key.');
  const limits = { label: 200, model: 200, thinkingLevel: 32 };
  for (const [k, max] of Object.entries(limits)) {
    const v = params[k];
    if (v !== undefined && v !== null && !isShortString(v, max, { allowEmpty: k === 'label' })) {
      return fail(`sessions.patch ${k} is invalid.`);
    }
  }
  return { ok: true };
}

/** Post-auth method allowlist with per-method param key allowlists. */
export function validateMethodParams(method, params) {
  if (typeof method !== 'string' || !Object.hasOwn(METHOD_PARAM_KEYS, method)) {
    return { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'That method is not available through the remote bridge.' };
  }
  if (!isPlainObject(params)) return { ok: false, code: 'INVALID_REQUEST', message: 'params must be an object.' };
  if (method === 'sessions.patch') return validateSessionPatch(params);
  if (!hasOnlyKeys(params, METHOD_PARAM_KEYS[method])) {
    return { ok: false, code: 'PARAM_NOT_ALLOWED', message: `A parameter is not allowed for ${method} through the remote bridge.` };
  }
  return { ok: true };
}

/**
 * Decide what to do with a parsed client request given the session phase. Does not mutate the session.
 * Returns {action:'forward', key, method, frame, role?, scopes?} | {action:'deny', frame} | {action:'close', reason, frame?}.
 */
export function authorizeRequest(frame, session) {
  const key = idKey(frame.id);
  if (session.pending.has(key)) return { action: 'close', reason: 'duplicate request id' };
  if (session.phase === 'challenged') {
    if (frame.method !== 'connect') return { action: 'close', reason: 'connect must be the first request' };
    const v = validateConnectParams(frame.params, session.challenge);
    if (!v.ok) {
      return { action: 'close', reason: `connect rejected: ${v.reason}`, frame: denyFrame(frame.id, 'INVALID_REQUEST', `Remote bridge rejected connect: ${v.reason}.`) };
    }
    return {
      action: 'forward', key, method: 'connect', role: v.role, scopes: v.scopes,
      frame: { type: 'req', id: frame.id, method: 'connect', params: v.params },
    };
  }
  if (session.phase === 'authenticated') {
    if (frame.method === 'connect') return { action: 'close', reason: 'connect after authentication' };
    if (session.role !== 'operator') {
      return { action: 'deny', frame: denyFrame(frame.id, 'FORBIDDEN', 'Bootstrap pairing connections cannot call methods.') };
    }
    const v = validateMethodParams(frame.method, frame.params);
    if (!v.ok) return { action: 'deny', frame: denyFrame(frame.id, v.code, v.message) };
    if (session.pending.size >= LIMITS.maxPendingRequests) {
      return { action: 'deny', frame: denyFrame(frame.id, 'TOO_MANY_PENDING', 'Too many requests in flight.') };
    }
    return { action: 'forward', key, method: frame.method, frame: { type: 'req', id: frame.id, method: frame.method, params: frame.params } };
  }
  return { action: 'close', reason: 'request received out of handshake order' };
}

// ---- Upstream (Gateway -> client) policy ----

export function sanitizeError(error) {
  const e = isPlainObject(error) ? error : {};
  const out = {
    code: isShortString(e.code, 64) ? e.code : 'UPSTREAM_ERROR',
    message: typeof e.message === 'string' ? e.message.slice(0, 500) : 'Request failed',
  };
  if (isPlainObject(e.details)) {
    const d = {};
    if (isShortString(e.details.code, 64)) d.code = e.details.code;
    if (isShortString(e.details.requestId, 128)) d.requestId = e.details.requestId;
    if (Number.isFinite(e.details.retryAfterMs) && e.details.retryAfterMs >= 0) d.retryAfterMs = Math.min(e.details.retryAfterMs, 3_600_000);
    if (Object.keys(d).length) out.details = d;
  }
  return out;
}

function sanitizeDeviceToken(t) {
  if (!isPlainObject(t) || !isToken(t.deviceToken) || (t.role !== 'operator' && t.role !== 'node')) return null;
  const scopes = t.scopes ?? [];
  if (!isScopeList(scopes, BOOTSTRAP_HANDOFF_SCOPES)) return null; // never relay admin/pairing grants
  const out = { deviceToken: t.deviceToken, role: t.role, scopes: scopes.filter(s => OPERATOR_SCOPES.includes(s)) };
  if (Number.isFinite(t.issuedAtMs)) out.issuedAtMs = t.issuedAtMs;
  return out;
}

function sanitizePolicy(policy) {
  const out = {};
  for (const k of ['maxPayload', 'maxBufferedBytes', 'tickIntervalMs']) {
    if (Number.isFinite(policy[k]) && policy[k] > 0) out[k] = policy[k];
  }
  out.maxPayload = Math.min(out.maxPayload ?? LIMITS.maxClientFrameBytes, LIMITS.maxClientFrameBytes);
  if (isPlainObject(policy.attachments)) {
    const att = {};
    const maxDecoded = Math.floor(LIMITS.maxClientFrameBytes * 0.7); // base64 + JSON overhead must fit a frame
    for (const [k, v] of Object.entries(policy.attachments)) {
      if (Number.isFinite(v)) att[k] = /bytes$/i.test(k) ? Math.min(v, maxDecoded) : v;
      else if (typeof v === 'boolean') att[k] = v;
      else if (Array.isArray(v) && v.length <= 64 && v.every((s) => isShortString(s, 128))) att[k] = [...v];
    }
    out.attachments = att;
  }
  return out;
}

/** Rebuilds hello-ok with only what companions use: no snapshot, presence, config or non-allowlisted features. */
export function sanitizeHello(payload) {
  const out = { type: 'hello-ok' };
  if (Number.isInteger(payload.protocol)) out.protocol = payload.protocol;
  if (isPlainObject(payload.server) && isShortString(payload.server.version, 64)) out.server = { version: payload.server.version };
  if (isPlainObject(payload.features)) {
    const f = payload.features;
    out.features = {
      methods: Array.isArray(f.methods) ? f.methods.filter((m) => typeof m === 'string' && Object.hasOwn(METHOD_PARAM_KEYS, m)) : [],
      events: Array.isArray(f.events) ? f.events.filter((e) => typeof e === 'string' && ALLOWED_EVENTS.includes(e)) : [],
    };
  }
  if (isPlainObject(payload.auth)) {
    const a = payload.auth;
    const auth = {};
    if (isToken(a.deviceToken)) auth.deviceToken = a.deviceToken;
    if (a.role === 'operator' || a.role === 'node') auth.role = a.role;
    if (Array.isArray(a.scopes)) auth.scopes = a.scopes.filter((s) => OPERATOR_SCOPES.includes(s));
    if (Number.isFinite(a.issuedAtMs)) auth.issuedAtMs = a.issuedAtMs;
    if (Array.isArray(a.deviceTokens)) auth.deviceTokens = a.deviceTokens.map(sanitizeDeviceToken).filter(Boolean);
    out.auth = auth;
  }
  if (isPlainObject(payload.policy)) out.policy = sanitizePolicy(payload.policy);
  return out;
}

/** Authentication completes only on an ok connect response whose grant stays inside the requested role and allowlist. */
export function checkHello(payload, session) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isPlainObject(payload)) return fail('hello payload missing');
  if (payload.type !== 'hello-ok' || payload.protocol !== PROTOCOL_VERSION) return fail('unexpected hello protocol');
  const auth = payload.auth;
  if (!isPlainObject(auth)) return fail('malformed hello auth');
  if (auth.role !== session.requestedRole) return fail('gateway granted an unexpected role');
  const grantable = session.requestedRole === 'operator' ? (session.requestedScopes ?? OPERATOR_SCOPES) : [];
  if (!isScopeList(auth.scopes, grantable)) return fail('gateway granted scopes outside the request');
  if (session.requestedRole === 'operator' && Array.isArray(auth.deviceTokens) && auth.deviceTokens.length) return fail('unexpected credential handoff');
  if (session.requestedRole === 'node' && Array.isArray(auth.deviceTokens)) {
    if (auth.deviceTokens.length !== 1 || auth.deviceTokens[0]?.role !== 'operator'
      || !sanitizeDeviceToken(auth.deviceTokens[0])) return fail('invalid bootstrap operator handoff');
  }
  return { ok: true, payload: sanitizeHello(payload) };
}

function filterResponse(frame, session) {
  const key = idKey(frame.id);
  const method = session.pending.get(key);
  if (!method) return { action: 'drop' }; // never forward responses to requests this client did not make
  const errorFrame = () => ({ type: 'res', id: frame.id, ok: false, error: sanitizeError(frame.error) });
  if (method === 'connect') {
    if (session.phase !== 'connecting') return { action: 'close', reason: 'connect response out of order' };
    if (frame.ok !== true) return { action: 'connect-failed', key, frame: errorFrame() };
    const hello = checkHello(frame.payload, session);
    if (!hello.ok) return { action: 'close', reason: hello.reason };
    return { action: 'hello', key, frame: { type: 'res', id: frame.id, ok: true, payload: hello.payload } };
  }
  if (frame.ok !== true) return { action: 'response', key, frame: errorFrame() };
  return { action: 'response', key, frame: { type: 'res', id: frame.id, ok: true, payload: frame.payload } };
}

function filterEvent(frame, session) {
  const { event } = frame;
  if (event === 'connect.challenge') {
    if (session.phase !== 'awaiting-challenge') return { action: 'close', reason: 'unexpected challenge' };
    const p = frame.payload;
    if (!isPlainObject(p) || !isShortString(p.nonce, 256) || !Number.isFinite(p.ts)) return { action: 'close', reason: 'malformed challenge' };
    const challenge = { nonce: p.nonce, ts: p.ts };
    return { action: 'challenge', challenge, frame: { type: 'event', event, payload: { ...challenge } } };
  }
  if (session.phase !== 'authenticated' || !ALLOWED_EVENTS.includes(event)) return { action: 'drop' };
  if (session.role !== 'operator' && event !== 'tick' && event !== 'heartbeat') return { action: 'drop' };
  if (event === 'agent' && !(isPlainObject(frame.payload) && ALLOWED_AGENT_STREAMS.includes(frame.payload.stream))) {
    return { action: 'drop' };
  }
  // seq/stateVersion are intentionally not forwarded: filtered streams would show false gaps.
  return { action: 'event', frame: { type: 'event', event, payload: frame.payload } };
}

/**
 * Decide what to do with a parsed upstream frame. Does not mutate the session.
 * Returns {action:'drop'|'close'|'challenge'|'hello'|'connect-failed'|'response'|'event', ...}.
 */
export function filterUpstreamFrame(frame, session) {
  if (session.phase === 'closed') return { action: 'drop' };
  if (frame.type === 'res') return filterResponse(frame, session);
  if (frame.type === 'event') return filterEvent(frame, session);
  return { action: 'drop' };
}
