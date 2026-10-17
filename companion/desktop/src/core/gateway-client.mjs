// HomeAI Gateway protocol client (v4). Runs in the Electron main process only.
// Keys and tokens stay here; the renderer only sees sanitized state and events.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const PROTOCOL_VERSION = 4;
export const OPERATOR_SCOPES = ['operator.read', 'operator.write', 'operator.approvals'];

/** Ed25519 identity: deviceId = sha256(raw public key) hex, publicKey = base64url raw 32 bytes. */
export function createIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
    publicKey: raw.toString('base64url'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    createdAtMs: Date.now(),
  };
}

export function buildAuthPayloadV3(p) {
  const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  return ['v3', p.deviceId, p.clientId, p.clientMode, p.role, p.scopes.join(','), String(p.signedAtMs),
    p.token ?? '', p.nonce, lower(p.platform), lower(p.deviceFamily)].join('|');
}

export function signPayload(privateKeyPem, payload) {
  return crypto.sign(null, Buffer.from(payload, 'utf8'), privateKeyPem).toString('base64url');
}

/** Setup code = base64url JSON {url, bootstrapToken, expiresAtMs}. Throws on malformed/expired codes. */
export function parseSetupCode(code, now = Date.now()) {
  const trimmed = String(code ?? '').trim();
  if (!trimmed) throw new Error('Setup code is empty.');
  let data;
  try {
    data = JSON.parse(Buffer.from(trimmed, 'base64url').toString('utf8'));
  } catch {
    throw new Error('That does not look like a HomeAI setup code.');
  }
  if (typeof data?.url !== 'string' || typeof data?.bootstrapToken !== 'string' || !data.bootstrapToken) {
    throw new Error('Setup code is missing its Gateway address or token.');
  }
  if (typeof data.expiresAtMs === 'number' && data.expiresAtMs < now) {
    throw new Error('Setup code has expired. Generate a new one with: openclaw qr --limited');
  }
  assertAllowedUrl(data.url);
  return { url: data.url, bootstrapToken: data.bootstrapToken, expiresAtMs: data.expiresAtMs ?? null };
}

/** Plaintext ws:// only for loopback, RFC1918, CGNAT/tailnet IPs and .local hosts. */
export function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 100 && b >= 64 && b <= 127);
}

export function assertAllowedUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Invalid Gateway URL: ${url}`); }
  if (u.protocol === 'wss:') return u;
  if (u.protocol === 'ws:' && isPrivateHost(u.hostname)) return u;
  throw new Error('Gateway URL must be wss:// (plain ws:// is only allowed on a private network).');
}

export function newSessionKey(agentId = 'main') {
  return `agent:${agentId}:companion:${crypto.randomUUID()}`;
}

const TERMINAL_CHAT_STATES = new Set(['final', 'aborted', 'error']);

/**
 * store contract (async):
 *   loadIdentity() -> identity|null, saveIdentity(identity)
 *   loadConnection() -> {url, deviceToken?, gatewayToken?, bootstrapToken?}|null, saveConnection(conn|null)
 */
export class GatewayClient extends EventEmitter {
  constructor({ store, client, WebSocketImpl = globalThis.WebSocket, userAgent = 'homeai/1.0', locale = 'en-US', logger = () => {} }) {
    super();
    this.store = store;
    this.client = client; // {id, version, platform, mode, deviceFamily}
    this.WebSocketImpl = WebSocketImpl;
    this.userAgent = userAgent;
    this.locale = locale;
    this.log = logger;
    this.state = 'idle';
    this.detail = null;
    this.hello = null;
    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
    this.backoffMs = 1000;
    this.retryTimer = null;
    this.watchdog = null;
    this.lastFrameAt = 0;
    this.stopped = true;
    this.epoch = 0;
    this.connectionWrites = Promise.resolve();
    this.activeRuns = new Map(); // sessionKey -> runId
  }

  setState(state, detail = null) {
    this.state = state;
    this.detail = detail;
    this.emit('status', { state, detail });
  }

  get connected() { return this.state === 'connected'; }

  async start() {
    const epoch = ++this.epoch;
    this.stopped = false;
    clearTimeout(this.retryTimer);
    const conn = await this.store.loadConnection();
    if (this.stopped || epoch !== this.epoch) return;
    if (!conn?.url) return this.setState('unconfigured');
    this.connect(conn);
  }

  stop() {
    this.epoch++;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.teardown(1000, 'client stop');
    this.setState('idle');
  }

  /** Pair with a setup code (preferred) or with URL + gateway token (advanced). */
  async configure({ setupCode, url, gatewayToken }) {
    let conn;
    if (setupCode) {
      const parsed = parseSetupCode(setupCode);
      conn = { url: parsed.url, bootstrapToken: parsed.bootstrapToken, bootstrapExpiresAtMs: parsed.expiresAtMs };
    } else {
      assertAllowedUrl(url);
      if (!gatewayToken) throw new Error('A Gateway token is required.');
      conn = { url, gatewayToken };
    }
    this.stop();
    const epoch = this.epoch;
    if (!await this.saveConnection(conn, epoch) || epoch !== this.epoch) return;
    this.backoffMs = 1000;
    await this.start();
  }

  async forget() {
    this.stop();
    const epoch = this.epoch;
    if (!await this.saveConnection(null, epoch) || epoch !== this.epoch) return;
    this.setState('unconfigured');
  }

  // Serialize credential writes, so Forget wins over an in-flight handoff save.
  saveConnection(value, epoch = this.epoch) {
    const write = this.connectionWrites.catch(() => {}).then(async () => {
      if (epoch !== this.epoch) return false;
      await this.store.saveConnection(value);
      return true;
    });
    this.connectionWrites = write;
    return write;
  }

  async identity() {
    let id = await this.store.loadIdentity();
    if (!id) {
      id = createIdentity();
      await this.store.saveIdentity(id);
    }
    return id;
  }

  connect(conn) {
    this.teardown(1000, 'reconnect');
    this.setState('connecting', { url: conn.url });
    let ws;
    try {
      assertAllowedUrl(conn.url);
      ws = new this.WebSocketImpl(conn.url);
    } catch (err) {
      return this.fail(err.message, true);
    }
    this.ws = ws;
    this.lastFrameAt = Date.now();
    ws.onmessage = (ev) => { if (this.ws === ws) this.onFrame(conn, ev.data).catch((err) => this.log('frame error', err)); };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.rejectAll(new Error('Connection closed'));
      clearInterval(this.watchdog);
      if (this.stopped) return;
      if (this.state === 'pairing' || this.state === 'auth-error') return this.scheduleRetry(this.state === 'pairing' ? 5000 : null);
      this.setState('offline', { code: ev.code, reason: ev.reason });
      this.scheduleRetry();
    };
  }

  scheduleRetry(fixedMs = undefined) {
    if (this.stopped || fixedMs === null) return;
    const wait = fixedMs ?? Math.min(this.backoffMs, 30000) * (0.8 + Math.random() * 0.4);
    if (fixedMs === undefined) this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), wait);
  }

  fail(message, retry) {
    this.setState('error', { message });
    if (retry) this.scheduleRetry();
  }

  teardown(code, reason) {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.watchdog);
    this.rejectAll(new Error('Connection closed'));
    if (ws) try { ws.close(code, reason); } catch { /* already closed */ }
  }

  rejectAll(err) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
    this.pending.clear();
  }

  send(frame) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('Not connected to HomeAI.');
    this.ws.send(JSON.stringify(frame));
  }

  rawRequest(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ type: 'req', id, method, params }); } catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  /** Request that resolves to payload or throws an Error carrying {code, details}. */
  async request(method, params = {}, timeoutMs) {
    if (!this.connected) throw new Error('Not connected to HomeAI.');
    const res = await this.rawRequest(method, params, timeoutMs);
    if (res.ok) return res.payload;
    const err = new Error(res.error?.message ?? `${method} failed`);
    err.code = res.error?.code;
    err.details = res.error?.details;
    throw err;
  }

  async onFrame(conn, data) {
    this.lastFrameAt = Date.now();
    const frame = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    if (frame.type === 'res') {
      const p = this.pending.get(frame.id);
      if (p) { clearTimeout(p.timer); this.pending.delete(frame.id); p.resolve(frame); }
      return;
    }
    if (frame.type !== 'event') return;
    if (frame.event === 'connect.challenge') return this.handshake(conn, frame.payload);
    if (frame.event === 'chat') this.trackRun(frame.payload);
    this.emit('event', frame.event, frame.payload);
  }

  trackRun(p) {
    if (!p?.sessionKey) return;
    if (TERMINAL_CHAT_STATES.has(p.state)) this.activeRuns.delete(p.sessionKey);
    else if (p.runId) this.activeRuns.set(p.sessionKey, p.runId);
  }

  async handshake(conn, challenge, socket = this.ws, epoch = this.epoch) {
    const current = () => epoch === this.epoch && socket === this.ws;
    const id = await this.identity();
    if (!current()) return;
    const bootstrap = !conn.deviceToken && !conn.gatewayToken && conn.bootstrapToken;
    // Desktop webchat is an operator from its first request; only the Android
    // identity supports the Gateway's native node -> operator setup handoff.
    const mobileBootstrap = bootstrap && this.client.id === 'openclaw-android';
    const role = mobileBootstrap ? 'node' : 'operator';
    const scopes = mobileBootstrap ? [] : OPERATOR_SCOPES;
    const client = mobileBootstrap ? { ...this.client, mode: 'node' } : this.client;
    // Gateway binds bootstrap proof to the same credential carried in auth.bootstrapToken.
    const token = bootstrap ? conn.bootstrapToken : (conn.deviceToken ?? conn.gatewayToken ?? '');
    const signedAt = challenge.ts;
    const signature = signPayload(id.privateKeyPem, buildAuthPayloadV3({
      deviceId: id.deviceId, clientId: client.id, clientMode: client.mode, role, scopes,
      signedAtMs: signedAt, token, nonce: challenge.nonce, platform: client.platform, deviceFamily: client.deviceFamily,
    }));
    const res = await this.rawRequest('connect', {
      minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION, client, role, scopes,
      caps: bootstrap ? [] : ['tool-events'],
      commands: [], permissions: {},
      auth: bootstrap ? { bootstrapToken: conn.bootstrapToken } : { token },
      locale: this.locale, userAgent: this.userAgent,
      device: { id: id.deviceId, publicKey: id.publicKey, signature, signedAt, nonce: challenge.nonce },
    });
    if (!current()) return;
    if (!res.ok) return this.onConnectError(conn, res.error, id);
    const hello = res.payload;

    if (mobileBootstrap) {
      const op = hello.auth?.deviceTokens?.find((t) => t.role === 'operator');
      if (!op?.deviceToken || !OPERATOR_SCOPES.every(scope => op.scopes?.includes(scope))) {
        this.teardown(1000, 'invalid bootstrap handoff');
        return this.fail('Pairing succeeded but the Gateway did not hand off operator access. Generate a new setup code.', false);
      }
      if (!await this.saveConnection({ url: conn.url, deviceToken: op.deviceToken, scopes: op.scopes }, epoch) || !current()) return;
      this.teardown(1000, 'bootstrap complete');
      return this.start();
    }
    if (hello.auth?.deviceToken && hello.auth.deviceToken !== conn.deviceToken) {
      // Prefer the per-device credential from now on; drop the shared gateway token.
      if (!await this.saveConnection({ url: conn.url, deviceToken: hello.auth.deviceToken, scopes: hello.auth.scopes }, epoch) || !current()) return;
    }
    this.hello = hello;
    this.backoffMs = 1000;
    const tickMs = hello.policy?.tickIntervalMs ?? 15000;
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastFrameAt > tickMs * 3) {
        this.teardown(4000, 'heartbeat timeout');
        this.setState('offline', { message: 'Connection interrupted. Reconnecting…' });
        this.scheduleRetry();
      }
    }, tickMs);
    this.setState('connected', {
      url: conn.url, deviceId: id.deviceId, scopes: hello.auth?.scopes ?? [],
      server: hello.server?.version ?? null, policy: hello.policy ?? {},
    });
    this.rawRequest('sessions.subscribe', {}).catch(() => {});
  }

  async onConnectError(conn, error, id) {
    const code = error?.details?.code ?? error?.code;
    if (code === 'PAIRING_REQUIRED' || error?.code === 'NOT_PAIRED') {
      if (conn.bootstrapExpiresAtMs && conn.bootstrapExpiresAtMs < Date.now()) {
        return this.setState('auth-error', { message: 'Setup code expired before it was approved. Generate a new one.' });
      }
      this.setState('pairing', {
        requestId: error?.details?.requestId ?? null,
        deviceId: id.deviceId,
        approveCommand: error?.details?.requestId ? `openclaw devices approve ${error.details.requestId}` : 'openclaw devices list',
      });
      this.teardown(1000, 'awaiting approval');
      return this.scheduleRetry(5000);
    }
    if (error?.details?.retryAfterMs) {
      this.setState('connecting', { message: error.message });
      return this.scheduleRetry(error.details.retryAfterMs);
    }
    if (code === 'AUTH_TOKEN_MISMATCH' && conn.deviceToken && conn.gatewayToken) {
      await this.saveConnection({ ...conn, deviceToken: undefined });
      return this.scheduleRetry(500);
    }
    this.setState('auth-error', { code, message: error?.message ?? 'Authentication failed' });
  }

  // ---- High-level API used by the app ----

  /** Rows carry `key`, `derivedTitle`, `label`, `lastMessagePreview`, `updatedAt`, `agentId`, `model`, `pinned`, `hasActiveRun`. */
  listSessions({ limit = 60, offset = 0 } = {}) {
    return this.request('sessions.list', {
      limit, offset, includeDerivedTitles: true, includeLastMessage: true,
      excludeCron: true, excludeSystem: true, excludeSubagents: true, sortBy: 'lastInteractionAt',
    });
  }

  searchSessions(query, limit = 20) {
    return this.request('sessions.search', { query, limit });
  }

  history(sessionKey, limit = 200) {
    return this.request('chat.history', { sessionKey, limit });
  }

  sendMessage({ sessionKey, message, attachments, thinking, idempotencyKey = crypto.randomUUID() }) {
    return this.request('chat.send', {
      sessionKey, message, idempotencyKey,
      ...(attachments?.length ? { attachments } : {}),
      ...(thinking ? { thinking } : {}),
    }, 60000);
  }

  abort(sessionKey) {
    const runId = this.activeRuns.get(sessionKey);
    return this.request('chat.abort', { sessionKey, ...(runId ? { runId } : {}) });
  }

  patchSession(key, patch) { return this.request('sessions.patch', { key, ...patch }); }
  deleteSession(key) { return this.request('sessions.delete', { key }); }
  listModels() { return this.request('models.list', {}); }
  listAgents() { return this.request('agents.list', {}); }
}
