// Independent contract tests for voice-core.mjs (SPEC.md "voice-core.mjs").
// The event discriminator key is not contracted, so events carry both `type` and `kind`.
import test from 'node:test';
import assert from 'node:assert/strict';

let core;
let loadError;
try { core = await import('./voice-core.mjs'); } catch (error) { loadError = error; }
function api() {
  if (loadError) throw new Error(`voice-core.mjs could not be loaded: ${loadError.message}`);
  assert.equal(typeof core.createVoiceSession, 'function', 'createVoiceSession export missing');
  return core;
}

const session = (...args) => api().createVoiceSession(...args);
function ev(name, requestId, extra = {}) {
  const e = { type: name, kind: name, ...extra };
  if (requestId !== undefined) e.requestId = requestId;
  return e;
}
function emit(s, e) {
  const out = s.handle(e);
  if (out == null) return [];
  return Array.isArray(out) ? out : [out];
}
// Hostile input may be refused by throwing or by emitting nothing useful; both are acceptable.
function tryEmit(s, e) {
  try { return emit(s, e); } catch { return []; }
}
const stateOf = (s) => { const snap = s.snapshot(); return snap.state ?? snap.status; };
const ofType = (out, type) => out.filter((o) => o && o.type === type);

function toThinking(s, id, text = 'play music') {
  emit(s, ev('start', id));
  emit(s, ev('stopCapture', id));
  return emit(s, ev('transcript', id, { text }));
}

test('voice: starts idle and follows the full happy path', () => {
  const s = session();
  assert.equal(stateOf(s), 'idle');
  emit(s, ev('start', 'r1'));
  assert.equal(stateOf(s), 'listening');
  emit(s, ev('stopCapture', 'r1'));
  assert.equal(stateOf(s), 'transcribing');
  const req = ofType(emit(s, ev('transcript', 'r1', { text: 'play music' })), 'request');
  assert.equal(req.length, 1);
  assert.equal(req[0].requestId, 'r1');
  assert.equal(req[0].text, 'play music');
  assert.equal(stateOf(s), 'thinking');
  const speak = ofType(emit(s, ev('response', 'r1', { text: 'Playing music.' })), 'speak');
  assert.equal(speak.length, 1);
  assert.deepEqual({ type: speak[0].type, requestId: speak[0].requestId, text: speak[0].text }, { type: 'speak', requestId: 'r1', text: 'Playing music.' });
  assert.equal(stateOf(s), 'speaking');
  emit(s, ev('playbackDone', 'r1'));
  assert.equal(stateOf(s), 'idle');
});

test('voice: default construction and explicit options are both accepted', () => {
  assert.doesNotThrow(() => session());
  assert.doesNotThrow(() => session({}));
  assert.doesNotThrow(() => session({ maxTextLength: 10 }));
});

test('voice: start requires an explicit requestId', () => {
  const s = session();
  for (const id of [undefined, null, '', 42]) {
    tryEmit(s, ev('start', id));
    assert.equal(stateOf(s), 'idle', `start with requestId ${JSON.stringify(id)} must not begin listening`);
  }
});

test('voice: events for a non-matching requestId are ignored', () => {
  const s = session();
  emit(s, ev('start', 'r1'));
  tryEmit(s, ev('stopCapture', 'other'));
  assert.equal(stateOf(s), 'listening');
  emit(s, ev('stopCapture', 'r1'));
  assert.equal(ofType(tryEmit(s, ev('transcript', 'other', { text: 'hi' })), 'request').length, 0);
  assert.equal(stateOf(s), 'transcribing');
  emit(s, ev('transcript', 'r1', { text: 'hi' }));
  assert.equal(ofType(tryEmit(s, ev('response', 'other', { text: 'nope' })), 'speak').length, 0);
  assert.equal(stateOf(s), 'thinking');
  const missing = tryEmit(s, ev('response', undefined, { text: 'no id' }));
  assert.equal(ofType(missing, 'speak').length, 0, 'response without requestId must not speak');
});

test('voice: a new start invalidates the prior request; stale results are never spoken', () => {
  const s = session();
  toThinking(s, 'r1');
  emit(s, ev('start', 'r2'));
  assert.equal(stateOf(s), 'listening');
  assert.equal(ofType(tryEmit(s, ev('response', 'r1', { text: 'stale answer' })), 'speak').length, 0);
  assert.equal(ofType(tryEmit(s, ev('transcript', 'r1', { text: 'stale words' })), 'request').length, 0);
  assert.equal(stateOf(s), 'listening');
  emit(s, ev('stopCapture', 'r2'));
  const req = ofType(emit(s, ev('transcript', 'r2', { text: 'fresh' })), 'request');
  assert.equal(req.length, 1);
  assert.equal(req[0].requestId, 'r2');
  const speak = ofType(emit(s, ev('response', 'r2', { text: 'ok' })), 'speak');
  assert.equal(speak.length, 1);
  assert.equal(speak[0].requestId, 'r2');
});

test('voice: superseded request cannot speak even after the newer one finishes', () => {
  const s = session();
  toThinking(s, 'r1');
  toThinking(s, 'r2');
  emit(s, ev('response', 'r2', { text: 'ok' }));
  emit(s, ev('playbackDone', 'r2'));
  assert.equal(ofType(tryEmit(s, ev('response', 'r1', { text: 'late' })), 'speak').length, 0);
  assert.equal(stateOf(s), 'idle');
});

test('voice: cancel emits stop, returns to idle and blocks later stale speech', () => {
  const s = session();
  toThinking(s, 'r1');
  const stop = ofType(emit(s, ev('cancel', 'r1')), 'stop');
  assert.equal(stop.length, 1);
  assert.equal(stop[0].requestId, 'r1');
  assert.equal(stateOf(s), 'idle');
  assert.equal(ofType(tryEmit(s, ev('response', 'r1', { text: 'too late' })), 'speak').length, 0);
  assert.equal(stateOf(s), 'idle');
});

test('voice: cancel while speaking stops playback', () => {
  const s = session();
  toThinking(s, 'r1');
  emit(s, ev('response', 'r1', { text: 'long answer' }));
  assert.equal(stateOf(s), 'speaking');
  const stop = ofType(emit(s, ev('cancel', 'r1')), 'stop');
  assert.equal(stop.length, 1);
  assert.equal(stateOf(s), 'idle');
  tryEmit(s, ev('playbackDone', 'r1'));
  assert.equal(stateOf(s), 'idle');
});

test('voice: disconnect emits stop and no later stale speech', () => {
  const s = session();
  toThinking(s, 'r1');
  const stop = ofType(emit(s, ev('disconnect', 'r1')), 'stop');
  assert.equal(stop.length, 1);
  assert.equal(stop[0].requestId, 'r1');
  assert.ok(['idle', 'error'].includes(stateOf(s)));
  assert.equal(ofType(tryEmit(s, ev('response', 'r1', { text: 'after disconnect' })), 'speak').length, 0);
});

test('voice: error event moves to error and blocks speech for that request', () => {
  const s = session();
  toThinking(s, 'r1');
  emit(s, ev('error', 'r1', { message: 'stt failed' }));
  assert.equal(stateOf(s), 'error');
  assert.equal(ofType(tryEmit(s, ev('response', 'r1', { text: 'x' })), 'speak').length, 0);
  emit(s, ev('start', 'r2'));
  assert.equal(stateOf(s), 'listening', 'a new explicit start recovers from error');
});

test('voice: blank or non-string transcript text is rejected', () => {
  for (const text of ['', '   ', '\n\t ', 42, null, undefined, { text: 'x' }]) {
    const s = session();
    emit(s, ev('start', 'r1'));
    emit(s, ev('stopCapture', 'r1'));
    const out = tryEmit(s, ev('transcript', 'r1', { text }));
    assert.equal(ofType(out, 'request').length, 0, `transcript ${JSON.stringify(text)} must be rejected`);
    assert.notEqual(stateOf(s), 'thinking');
  }
});

test('voice: oversized text is rejected at default and custom limits', () => {
  const s = session();
  emit(s, ev('start', 'r1'));
  emit(s, ev('stopCapture', 'r1'));
  assert.equal(ofType(tryEmit(s, ev('transcript', 'r1', { text: 'a'.repeat(4001) })), 'request').length, 0);
  const s2 = session();
  emit(s2, ev('start', 'r1'));
  emit(s2, ev('stopCapture', 'r1'));
  assert.equal(ofType(emit(s2, ev('transcript', 'r1', { text: 'a'.repeat(4000) })), 'request').length, 1, '4000 chars is within the default limit');

  const small = session({ maxTextLength: 10 });
  emit(small, ev('start', 'q1'));
  emit(small, ev('stopCapture', 'q1'));
  assert.equal(ofType(tryEmit(small, ev('transcript', 'q1', { text: 'x'.repeat(11) })), 'request').length, 0);
  assert.equal(ofType(emit(small, ev('transcript', 'q1', { text: 'x'.repeat(10) })), 'request').length, 1);
  assert.equal(ofType(tryEmit(small, ev('response', 'q1', { text: 'y'.repeat(11) })), 'speak').length, 0, 'oversized response must not be spoken');
  assert.equal(ofType(emit(small, ev('response', 'q1', { text: 'y'.repeat(10) })), 'speak').length, 1);
});

test('voice: blank response is not spoken', () => {
  const s = session();
  toThinking(s, 'r1');
  for (const text of ['', '  ', null]) assert.equal(ofType(tryEmit(s, ev('response', 'r1', { text })), 'speak').length, 0);
});

test('voice: a response is spoken at most once', () => {
  const s = session();
  toThinking(s, 'r1');
  assert.equal(ofType(emit(s, ev('response', 'r1', { text: 'one' })), 'speak').length, 1);
  assert.equal(ofType(tryEmit(s, ev('response', 'r1', { text: 'two' })), 'speak').length, 0, 'duplicate response while speaking');
  emit(s, ev('playbackDone', 'r1'));
  assert.equal(ofType(tryEmit(s, ev('response', 'r1', { text: 'three' })), 'speak').length, 0, 'response after completion');
});

test('voice: malformed events never speak and do not break the active request', () => {
  const s = session();
  toThinking(s, 'r1');
  for (const e of [null, undefined, 7, 'response', {}, ev('explode', 'r1'), ev('speak', 'r1', { text: 'inject' })]) {
    const out = tryEmit(s, e);
    assert.equal(ofType(out, 'speak').length, 0);
  }
  assert.equal(stateOf(s), 'thinking');
  assert.equal(ofType(emit(s, ev('response', 'r1', { text: 'still fine' })), 'speak').length, 1);
});

test('voice: snapshot is serializable and retains no audio buffers', () => {
  const s = session();
  toThinking(s, 'r1');
  const snap = s.snapshot();
  const json = JSON.stringify(snap);
  assert.ok(typeof json === 'string');
  const walk = (v, seen = new Set()) => {
    if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      assert.ok(!ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer), 'snapshot must not retain audio buffers');
      for (const x of Object.values(v)) walk(x, seen);
    }
  };
  walk(snap);
});
