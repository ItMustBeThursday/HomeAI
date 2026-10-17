import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { LIMITS, parseClientFrame, authorizeRequest, createSession, filterUpstreamFrame, buildUpstreamHeaders, createRateLimiter } from './policy.mjs';

// Proposed contract documented in docs/REMOTE-TEST-PLAN.md.
const MAX_BYTES = LIMITS.maxClientFrameBytes;
const challenge = { ts: 1792065600000, nonce: 'offline-challenge' };
const scopes = ['operator.read', 'operator.write', 'operator.approvals'];
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const rawKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
const deviceId = createHash('sha256').update(rawKey).digest('hex');
function connect(role = 'operator', requestedScopes = scopes) {
  const signedAt = 1792065600000;
  const nonce = 'offline-challenge';
  const token = role === 'node' ? 'offline-bootstrap-token' : 'offline-device-token';
  const mode = role === 'node' ? 'node' : 'ui';
  const payload = ['v3', deviceId, 'webchat', mode, role,
    requestedScopes.join(','), signedAt, token, nonce, 'windows', 'desktop'].join('|');
  return {
    type: 'req', id: 'connect-1', method: 'connect',
    params: {
      minProtocol: 4, maxProtocol: 4,
      client: { id: 'webchat', version: '1.0.0', platform: 'windows', mode, deviceFamily: 'desktop' },
      role, scopes: [...requestedScopes], caps: ['tool-events'],
      auth: role === 'node' ? { bootstrapToken: token } : { token },
      device: { id: deviceId, publicKey: rawKey.toString('base64url'),
        signature: sign(null, Buffer.from(payload), privateKey).toString('base64url'),
        signedAt, nonce },
    },
  };
}
function request(method, params = {}) {
  return { type: 'req', id: 'request-1', method, params };
}
function check(frame, authenticated, expected) {
  const parsed = parseClientFrame(frame, false);
  if (!parsed.ok) { assert.equal(expected, false, parsed.reason); return; }
  const session = createSession();
  session.phase = authenticated === true ? 'authenticated' : 'challenged';
  session.role = authenticated === true ? 'operator' : null;
  session.challenge = challenge;
  const result = authorizeRequest(parsed.frame, session);
  assert.equal(result.action === 'forward', expected, JSON.stringify(result));
}
const allow = (value, authenticated = true) => check(JSON.stringify(value), authenticated, true);
const deny = (value, authenticated = true) => check(JSON.stringify(value), authenticated, false);

test('signed operator connect allows least-privilege scopes', () => {
  for (const set of [scopes, ['operator.read'], ['operator.write'], ['operator.approvals']]) {
    allow(connect('operator', set), false);
  }
});
test('signed bootstrap node connect allows empty scopes', () => allow(connect('node', []), false));
test('connect denies admin and unknown scopes, including mixed grants', () => {
  for (const scope of ['operator.admin', 'operator.*', 'admin', 'operator.pairing', 'operator.READ', '']) {
    deny(connect('operator', [...scopes, scope]), false);
  }
});
test('node bootstrap cannot request operator scopes or use device-token auth', () => {
  deny(connect('node', ['operator.read']), false);
  const frame = connect('node', []);
  frame.params.auth = { token: 'offline-device-token' };
  deny(frame, false);
});
test('connect denies missing device and incomplete signed identity', () => {
  const missing = connect(); delete missing.params.device; deny(missing, false);
  for (const key of ['id', 'publicKey', 'signature', 'signedAt', 'nonce']) {
    const frame = connect(); delete frame.params.device[key]; deny(frame, false);
  }
  for (const device of [null, [], {}, 'device']) {
    const frame = connect(); frame.params.device = device; deny(frame, false);
  }
});
test('connect denies unsupported roles and malformed scopes', () => {
  for (const role of ['admin', 'owner', '', null]) {
    const frame = connect(); frame.params.role = role; deny(frame, false);
  }
  for (const value of [null, 'operator.read', {}, [null], [1]]) {
    const frame = connect(); frame.params.scopes = value; deny(frame, false);
  }
});
test('connect denies missing auth, mixed auth, and protocol mismatch', () => {
  for (const auth of [undefined, {}, { token: '' },
    { token: 'a', bootstrapToken: 'b' }]) {
    const frame = connect(); frame.params.auth = auth; deny(frame, false);
  }
  const frame = connect(); frame.params.minProtocol = 3; frame.params.maxProtocol = 3;
  deny(frame, false);
});
const allowedRequests = [
  ['sessions.list', { limit: 20 }],
  ['chat.history', { sessionKey: 'agent:main:companion:test', limit: 20 }],
  ['chat.send', { sessionKey: 'agent:main:companion:test', message: 'hello', idempotencyKey: 'offline-1' }],
  ['chat.abort', { sessionKey: 'agent:main:companion:test' }],
  ['sessions.patch', { key: 'agent:main:companion:test', label: 'Test', model: 'local-model' }],
  ['sessions.delete', { key: 'agent:main:companion:test' }],
  ['models.list', {}], ['agents.list', {}], ['sessions.subscribe', {}],
  ['sessions.search', { query: 'offline', limit: 20 }],
];
for (const [method, params] of allowedRequests) {
  test('authenticated allowlist: ' + method, () => allow(request(method, params)));
  test('unauthenticated denies: ' + method, () => deny(request(method, params), false));
}
test('unknown and administrative methods are denied', () => {
  for (const method of ['unknown.method', 'config.set', 'config.patch', 'gateway.restart',
    'devices.approve', 'exec.approval.resolve', 'exec', 'sessions.list ', 'Sessions.list', '__proto__', 'constructor']) {
    deny(request(method));
    deny(request(method), false);
  }
});
test('authentication must be literal true and repeat connect is denied', () => {
  for (const authenticated of [undefined, null, false, 0, 1, 'true', {}, []]) {
    check(JSON.stringify(request('models.list')), authenticated, false);
  }
  deny(connect(), true);
});
test('sessions.patch uses a strict key/label/model field allowlist', () => {
  for (const field of ['role', 'scopes', 'auth', 'device', 'token', 'admin',
    'tools', 'toolsAllow', 'exec', 'execSecurity', 'execAsk', 'elevated',
    'elevatedLevel', 'sandbox', 'permissions', 'systemPrompt', 'agentId',
    '__proto__', 'constructor', 'prototype', 'futureUnknownField']) {
    const params = { key: 'agent:main:companion:test', [field]: 'escalate' };
    deny(request('sessions.patch', params));
  }
});
test('sessions.patch rejects wrong types and missing session key', () => {
  for (const params of [{}, { label: 'x' }, { key: '' }, { key: 1 },
    { key: 'x', label: { role: 'admin' } }, { key: 'x', model: ['admin'] }]) {
    deny(request('sessions.patch', params));
  }
});
test('binary flag is denied and supported text transports accepted', () => {
  const text = JSON.stringify(request('models.list'));
  for (const frame of [text, Buffer.from(text), new TextEncoder().encode(text).buffer]) {
    assert.equal(parseClientFrame(frame, true).ok, false);
    check(frame, true, true);
  }
  for (const frame of [new Uint8Array(Buffer.from(text)), new ArrayBuffer(8), null, undefined, 42, {}, []]) check(frame, true, false);
});

test('malformed JSON and invalid envelopes are denied without throwing', () => {
  for (const frame of ['', ' ', '{', '{bad}', '{} trailing', 'null', '[]', 'true', '42', '"text"']) {
    check(frame, true, false);
  }
  for (const frame of [{}, { type: 'event', event: 'chat' },
    { type: 'res', id: 'x', ok: true }, { ...request('models.list'), id: '' },
    { ...request('models.list'), id: -1 }, { ...request('models.list'), method: null },
    { ...request('models.list'), params: null }, { ...request('models.list'), params: [] }]) deny(frame);
});
test('maximum payload is measured in UTF-8 bytes, at configured boundary', () => {
  const base = JSON.stringify(request('chat.send', {
    sessionKey: 'agent:main:companion:test', message: '', idempotencyKey: 'size-test',
  }));
  const remaining = MAX_BYTES - Buffer.byteLength(base);
  const sized = message => JSON.stringify(request('chat.send', {
    sessionKey: 'agent:main:companion:test', message, idempotencyKey: 'size-test',
  }));
  const boundary = sized('a'.repeat(remaining));
  assert.equal(Buffer.byteLength(boundary), MAX_BYTES);
  check(boundary, true, true);
  check(sized('a'.repeat(remaining + 1)), true, false);
  const unicode = sized('é'.repeat(Math.floor(remaining / 2) + 1));
  assert.ok(unicode.length < MAX_BYTES);
  assert.ok(Buffer.byteLength(unicode) > MAX_BYTES);
  check(unicode, true, false);
});

test('challenge identity, nonce, timestamp and signature encoding are bound', () => {
  for (const [field, value] of [['id', '0'.repeat(64)], ['nonce', 'replayed'], ['signedAt', challenge.ts - 1], ['publicKey', 'bad'], ['signature', 'bad']]) {
    const frame = connect(); frame.params.device[field] = value; deny(frame, false);
  }
  for (const mode of ['ui', 'cli']) {
    const frame = connect('node', []); frame.params.client.mode = mode; deny(frame, false);
  }
});
test('connect rejects command permissions, capabilities, duplicate scopes and unexpected fields', () => {
  for (const [field, value] of [['commands', ['system.run']], ['permissions', { exec: true }], ['caps', ['admin']], ['unknown', true], ['scopes', ['operator.read', 'operator.read']]]) {
    const frame = connect(); frame.params[field] = value; deny(frame, false);
  }
});
test('explicit handshake state ordering and bootstrap isolation', () => {
  for (const phase of ['awaiting-challenge', 'connecting', 'closed']) {
    const state = createSession(); state.phase = phase;
    assert.equal(authorizeRequest(connect(), state).action, 'close');
    assert.equal(authorizeRequest(request('models.list'), state).action, 'close');
  }
  const state = createSession(); state.phase = 'authenticated'; state.role = 'node';
  for (const [method, params] of allowedRequests) assert.equal(authorizeRequest(request(method, params), state).action, 'deny');
});
test('duplicate IDs and pending request bounds fail closed', () => {
  const state = createSession(); state.phase = 'authenticated'; state.role = 'operator';
  state.pending.set('string:request-1', 'models.list');
  assert.equal(authorizeRequest(request('models.list'), state).action, 'close');
  state.pending.clear();
  for (let n = 0; n < LIMITS.maxPendingRequests; n++) state.pending.set(`string:other-${n}`, 'models.list');
  assert.equal(authorizeRequest(request('models.list'), state).action, 'deny');
});
test('valid numeric IDs, omitted params and safe patch resets are accepted', () => {
  allow({ type: 'req', id: 0, method: 'models.list' });
  allow(request('sessions.patch', { key: 'x', label: null, model: null, thinkingLevel: 'high' }));
  for (const id of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5, '', 'x\n', 'a'.repeat(129)]) deny({ ...request('models.list'), id });
  for (const field of ['label', 'model', 'thinkingLevel']) deny(request('sessions.patch', { key: 'x', [field]: 'a'.repeat(513) }));
});
test('all allowlisted methods reject unknown params including prototype-like keys', () => {
  for (const [method, params] of allowedRequests) {
    for (const name of ['unknown', '__proto__', 'constructor']) deny(request(method, { ...params, [name]: true }));
  }
});
test('upstream authentication failure and admin grants never authenticate', () => {
  const state = createSession(); state.phase = 'connecting'; state.requestedRole = 'operator'; state.requestedScopes = scopes;
  state.pending.set('string:connect-1', 'connect');
  assert.equal(filterUpstreamFrame({ type: 'res', id: 'connect-1', ok: false, error: { code: 'DENIED', message: 'no' } }, state).action, 'connect-failed');
  for (const auth of [{ role: 'admin' }, { role: 'operator', scopes: ['operator.admin'] }]) {
    assert.equal(filterUpstreamFrame({ type: 'res', id: 'connect-1', ok: true, payload: { type: 'hello-ok', auth } }, state).action, 'close');
  }
  assert.equal(state.phase, 'connecting'); // Pure policy never authenticates on validation alone.
});
test('upstream unsolicited responses and privileged events are dropped; hello is sanitized', () => {
  const state = createSession(); state.phase = 'authenticated'; state.role = 'operator';
  assert.equal(filterUpstreamFrame({ type: 'res', id: 'unknown', ok: true }, state).action, 'drop');
  for (const event of ['config', 'device.pair.requested', 'exec.approval.requested']) assert.equal(filterUpstreamFrame({ type: 'event', event, payload: {} }, state).action, 'drop');
  assert.equal(filterUpstreamFrame({ type: 'event', event: 'agent', payload: { stream: 'private' } }, state).action, 'drop');
  state.phase = 'connecting'; state.requestedRole = 'operator'; state.pending.set('string:connect-1', 'connect');
  const result = filterUpstreamFrame({ type: 'res', id: 'connect-1', ok: true, payload: { type: 'hello-ok', protocol: 4, auth: { role: 'operator', scopes }, snapshot: { secret: 'test' }, features: { methods: ['models.list', 'config.get'], events: ['chat', 'private'] } } }, state);
  assert.equal(result.action, 'hello'); assert.equal(result.frame.payload.snapshot, undefined);
  assert.deepEqual(result.frame.payload.features, { methods: ['models.list'], events: ['chat'] });
});
test('upstream headers are rebuilt without supplied credential or identity values', () => {
  assert.deepEqual(buildUpstreamHeaders({ authorization: 'injected', 'x-forwarded-for': '127.0.0.1' }), { 'x-forwarded-for': '192.0.2.1' });
});
test('token bucket enforces burst and bounded refill without clock rollback gain', () => {
  const limiter = createRateLimiter({ capacity: 2, refillPerSec: 1 }, 1000);
  assert.equal(limiter.take(1000), true); assert.equal(limiter.take(1000), true); assert.equal(limiter.take(1000), false);
  assert.equal(limiter.take(500), false); assert.equal(limiter.take(2000), true); assert.equal(limiter.take(2000), false);
});
