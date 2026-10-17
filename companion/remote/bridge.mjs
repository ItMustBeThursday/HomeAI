// HomeAI remote companion bridge.
// Filtering WebSocket reverse proxy: 127.0.0.1:18896/companion -> ws://127.0.0.1:18795 (local Gateway).
// Holds no credentials: every client completes the Gateway's own signed device handshake end to end.
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  LISTEN_HOST, LISTEN_PORT, UPSTREAM_URL, LIMITS,
  authorizeRequest, buildUpstreamHeaders, checkUpgrade, closeReason, createRateLimiter, createSession,
  denyFrame, filterUpstreamFrame, parseClientFrame, parseUpstreamFrame, routeHttp,
} from './policy.mjs';

const connections = new Set();
let upgrading = 0;
let nextId = 1;
let stopping = false;

// Never log frame contents, params or headers: they can carry tokens and chat text.
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

function unauthenticatedCount() {
  let n = upgrading;
  for (const conn of connections) if (conn.session.phase !== 'authenticated') n += 1;
  return n;
}

/** Sends only to an open socket that is not backed up; false means the peer must be dropped. */
function sendFrame(ws, frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > LIMITS.maxBufferedBytes) return false;
  ws.send(JSON.stringify(frame));
  return true;
}

function shut(ws, code, reason) {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(code, closeReason(reason));
      const kill = setTimeout(() => ws.terminate(), 2000);
      kill.unref();
      ws.once('close', () => clearTimeout(kill));
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  } catch {
    try { ws.terminate(); } catch { /* already gone */ }
  }
}

function closeConn(conn, code, reason) {
  if (conn.closed) return;
  conn.closed = true;
  connections.delete(conn);
  clearTimeout(conn.handshakeTimer);
  conn.session.phase = 'closed';
  conn.session.pending.clear();
  shut(conn.client, code, reason);
  shut(conn.upstream, 1000, 'client closed');
  log(`conn ${conn.id} closed: ${closeReason(reason)}`);
}

function onClientMessage(conn, data, isBinary) {
  if (conn.closed) return;
  const parsed = parseClientFrame(data, isBinary);
  if (!parsed.ok) return closeConn(conn, isBinary ? 1003 : 1008, parsed.reason);
  const { session } = conn;

  if (session.phase === 'authenticated') {
    if (!conn.limiter.take(Date.now())) {
      conn.strikes += 1;
      if (conn.strikes > LIMITS.maxRateStrikes) return closeConn(conn, 1008, 'rate limit exceeded');
      return toClient(conn, denyFrame(parsed.frame.id, 'RATE_LIMITED', 'Too many requests; slow down.'));
    }
    conn.strikes = 0;
  }

  const decision = authorizeRequest(parsed.frame, session);
  if (decision.action === 'deny') return toClient(conn, decision.frame);
  if (decision.action === 'close') {
    if (decision.frame) sendFrame(conn.client, decision.frame);
    return closeConn(conn, 1008, decision.reason);
  }
  session.pending.set(decision.key, decision.method);
  if (decision.method === 'connect') {
    session.phase = 'connecting';
    session.requestedRole = decision.role;
    session.requestedScopes = decision.scopes;
  }
  if (!sendFrame(conn.upstream, decision.frame)) closeConn(conn, 1013, 'upstream unavailable');
}

function onUpstreamMessage(conn, data, isBinary) {
  if (conn.closed) return;
  const parsed = parseUpstreamFrame(data, isBinary);
  if (!parsed.ok) return closeConn(conn, 1011, `upstream ${parsed.reason}`);
  const { session } = conn;
  const d = filterUpstreamFrame(parsed.frame, session);
  switch (d.action) {
    case 'drop':
      return undefined;
    case 'challenge':
      session.challenge = d.challenge;
      session.phase = 'challenged';
      return toClient(conn, d.frame);
    case 'hello':
      session.pending.delete(d.key);
      session.phase = 'authenticated';
      session.role = session.requestedRole;
      clearTimeout(conn.handshakeTimer);
      log(`conn ${conn.id} authenticated as ${session.role}`);
      return toClient(conn, d.frame);
    case 'connect-failed':
      session.pending.delete(d.key);
      sendFrame(conn.client, d.frame);
      return closeConn(conn, 1008, 'connect rejected by gateway');
    case 'response':
      session.pending.delete(d.key);
      return toClient(conn, d.frame);
    case 'event':
      return toClient(conn, d.frame);
    case 'close':
      return closeConn(conn, 1011, d.reason);
    default:
      return closeConn(conn, 1011, 'internal policy error');
  }
}

function toClient(conn, frame) {
  if (!sendFrame(conn.client, frame)) closeConn(conn, 1013, 'client backpressure');
}

function startBridge(client) {
  const conn = {
    id: nextId++,
    client,
    upstream: null,
    session: createSession(),
    limiter: createRateLimiter({ capacity: LIMITS.rateCapacity, refillPerSec: LIMITS.rateRefillPerSec }, Date.now()),
    strikes: 0,
    alive: true,
    closed: false,
    handshakeTimer: null,
  };
  connections.add(conn);
  conn.handshakeTimer = setTimeout(() => closeConn(conn, 1008, 'handshake timeout'), LIMITS.handshakeTimeoutMs);
  log(`conn ${conn.id} opened (${connections.size} active)`);

  client.on('pong', () => { conn.alive = true; });
  client.on('error', () => closeConn(conn, 1011, 'client socket error'));
  client.on('close', () => closeConn(conn, 1000, 'client disconnected'));
  client.on('message', (data, isBinary) => onClientMessage(conn, data, isBinary));

  // Fresh upstream socket per client. Headers are built from scratch (no forwarded identity headers, no
  // Origin, no Authorization); auth happens only inside the client's own signed connect request.
  const upstream = new WebSocket(UPSTREAM_URL, {
    headers: buildUpstreamHeaders(),
    perMessageDeflate: false,
    maxPayload: LIMITS.maxUpstreamFrameBytes,
    handshakeTimeout: LIMITS.upstreamOpenTimeoutMs,
    followRedirects: false,
  });
  conn.upstream = upstream;
  upstream.on('error', () => closeConn(conn, 1011, 'upstream error'));
  upstream.on('close', () => closeConn(conn, 1011, 'upstream closed'));
  upstream.on('message', (data, isBinary) => onUpstreamMessage(conn, data, isBinary));
}

const wss = new WebSocketServer({
  noServer: true,
  clientTracking: false,
  perMessageDeflate: false,
  maxPayload: LIMITS.maxClientFrameBytes,
  handleProtocols: () => false,
});

const server = http.createServer({
  maxHeaderSize: 8192,
  requestTimeout: 10_000,
  headersTimeout: 10_000,
  keepAliveTimeout: 5_000,
}, (req, res) => {
  const r = routeHttp(req.method, req.url);
  res.writeHead(r.status, r.headers);
  res.end(req.method === 'HEAD' ? undefined : r.body);
});

server.on('clientError', (_err, socket) => socket.destroy());

server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  if (stopping) return socket.destroy();
  const check = checkUpgrade(req, { total: connections.size + upgrading, unauthenticated: unauthenticatedCount() });
  if (!check.ok) {
    log(`upgrade rejected: ${check.reason}`);
    socket.once('finish', () => socket.destroy());
    socket.end(`HTTP/1.1 ${check.status} ${http.STATUS_CODES[check.status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return undefined;
  }
  upgrading += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    upgrading -= 1;
  };
  socket.once('close', release);
  wss.handleUpgrade(req, socket, head, (ws) => {
    release();
    if (stopping) return ws.terminate();
    startBridge(ws);
    return undefined;
  });
  return undefined;
});

const pingTimer = setInterval(() => {
  for (const conn of connections) {
    if (!conn.alive) {
      closeConn(conn, 1001, 'ping timeout');
      continue;
    }
    conn.alive = false;
    try { conn.client.ping(); } catch { closeConn(conn, 1011, 'ping failed'); }
  }
}, LIMITS.pingIntervalMs);

function shutdown(why) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${why})`);
  clearInterval(pingTimer);
  server.close();
  for (const conn of connections) closeConn(conn, 1001, 'bridge shutting down');
  setTimeout(() => process.exit(), 2500).unref();
}

server.on('error', (err) => {
  log(`server error: ${err.code ?? err.message}`);
  process.exitCode = 1;
  shutdown('server error');
});

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`HomeAI remote bridge listening on ${LISTEN_HOST}:${LISTEN_PORT} (ws path /companion) -> ${UPSTREAM_URL}`);
});
