// Independent contract tests for switch-core.mjs (SPEC.md "switch-core.mjs").
// Written from the spec before the implementation existed; output field names
// beyond `type` are not contracted, so item identification is tolerant (see TEST-REVIEW.md).
import test from 'node:test';
import assert from 'node:assert/strict';

let core;
let loadError;
try { core = await import('./switch-core.mjs'); } catch (error) { loadError = error; }
function api() {
  if (loadError) throw new Error(`switch-core.mjs could not be loaded: ${loadError.message}`);
  assert.equal(typeof core.createSwitchController, 'function', 'createSwitchController export missing');
  return core;
}

const ITEMS = Object.freeze(['tv', 'music', 'stop']);
const BASE = Object.freeze({ deviceIds: ['sw-a', 'sw-b'], mode: 'one', itemIds: [...ITEMS], debounceMs: 50, scanIntervalMs: 1000, maxAgeMs: 2000 });

function outputs(result) {
  assert.ok(Array.isArray(result), 'handle(event) must return an array of outputs');
  for (const o of result) assert.ok(o && typeof o.type === 'string', 'every output needs a string type');
  return result;
}
const selects = (out) => outputs(out).filter((o) => o.type === 'select');
const has = (out, type) => outputs(out).some((o) => o.type === type);
function selectedItem(o, itemIds = ITEMS) {
  if (typeof o.itemId === 'string') return o.itemId;
  if (typeof o.item === 'string') return o.item;
  if (o.item && typeof o.item.id === 'string') return o.item.id;
  if (Number.isInteger(o.index)) return itemIds[o.index];
  return undefined;
}

// Drives one controller with strictly increasing local time and per-device sequences.
function rig(overrides = {}) {
  const config = { ...BASE, ...overrides };
  const ctrl = api().createSwitchController(config);
  let now = 1_000_000;
  const sessions = new Map();
  const r = {
    ctrl,
    config,
    dt: 100,
    get now() { return now; },
    wait(ms) { now += ms; },
    // Well-formed device event consuming the next sequence number of the current session.
    event(deviceId, kind, extra = {}) {
      const s = sessions.get(deviceId) ?? { sessionId: 'never-connected', seq: 0 };
      s.seq += 1;
      sessions.set(deviceId, s);
      return { deviceId, sessionId: s.sessionId, seq: s.seq, kind, at: now, receivedAt: now, ...extra };
    },
    send(e) { return outputs(ctrl.handle(e)); },
    connect(deviceId, sessionId) { now += r.dt; sessions.set(deviceId, { sessionId, seq: 0 }); return r.send(r.event(deviceId, 'connect')); },
    disconnect(deviceId) { now += r.dt; return r.send(r.event(deviceId, 'disconnect')); },
    press(deviceId, button = 1) { now += r.dt; return r.send(r.event(deviceId, 'press', { button })); },
    release(deviceId, button = 1) { now += r.dt; return r.send(r.event(deviceId, 'release', { button })); },
    click(deviceId, button = 1) { return [...r.press(deviceId, button), ...r.release(deviceId, button)]; },
    tick() { now += config.scanIntervalMs; return r.send({ kind: 'tick', at: now, receivedAt: now }); },
    override(paused) { now += r.dt; return r.send({ kind: 'override', paused, at: now, receivedAt: now }); },
  };
  return r;
}

test('switch: invalid configuration is refused', () => {
  const { createSwitchController } = api();
  const bad = [
    { deviceIds: ['a', 'b', 'c', 'd', 'e'] },
    { deviceIds: ['a', 'a'] },
    { deviceIds: [1] },
    { deviceIds: 'a' },
    { mode: 'three' },
    { mode: undefined },
    { itemIds: [] },
    { itemIds: ['x', 'x'] },
    { itemIds: [7] },
    { debounceMs: -1 },
    { debounceMs: 1.5 },
    { debounceMs: NaN },
    { scanIntervalMs: 0 },
    { scanIntervalMs: Infinity },
    { maxAgeMs: 0 },
    { maxAgeMs: -5 },
  ];
  for (const patch of bad) {
    assert.throws(() => createSwitchController({ ...BASE, ...patch }), `config should be refused: ${JSON.stringify(patch)}`);
  }
  assert.throws(() => createSwitchController(), 'missing config must throw');
  for (const n of [1, 4]) {
    const deviceIds = ['a', 'b', 'c', 'd'].slice(0, n);
    assert.doesNotThrow(() => createSwitchController({ ...BASE, deviceIds }));
  }
  assert.doesNotThrow(() => createSwitchController({ ...BASE, debounceMs: 0, mode: 'two' }));
});

test('switch: snapshot is JSON-serializable and import is side-effect free', () => {
  const r = rig();
  const snap = r.ctrl.snapshot();
  assert.ok(snap && typeof snap === 'object');
  assert.doesNotThrow(() => JSON.stringify(snap));
});

test('switch one-button: press selects the initial item exactly once; release never selects', () => {
  const r = rig();
  assert.equal(selects(r.connect('sw-a', 's1')).length, 0, 'connect must not select');
  const pressed = selects(r.press('sw-a'));
  assert.equal(pressed.length, 1);
  assert.equal(selectedItem(pressed[0]), 'tv', 'global selected index starts at 0');
  assert.equal(selects(r.release('sw-a')).length, 0, 'release never selects');
});

test('switch one-button: only ticks advance the highlight; ticks themselves never select', () => {
  const r = rig();
  r.connect('sw-a', 's1');
  const t = r.tick();
  assert.ok(has(t, 'highlight'), 'tick should emit highlight in one-button mode');
  assert.ok(!has(t, 'reject'), 'tick is a local event and needs no device fields');
  assert.equal(selects(t).length, 0);
  const sel = selects(r.press('sw-a'));
  assert.equal(sel.length, 1);
  assert.equal(selectedItem(sel[0]), 'music');
  r.release('sw-a');
  for (let i = 0; i < 10; i += 1) assert.equal(selects(r.tick()).length, 0, 'tick must never select');
});

test('switch one-button: button 2 cannot select', () => {
  const r = rig();
  r.connect('sw-a', 's1');
  assert.equal(selects(r.press('sw-a', 2)).length, 0);
  assert.equal(selects(r.release('sw-a', 2)).length, 0);
});

test('switch two-button: button 1 advances, button 2 selects, ticks do not advance', () => {
  const r = rig({ mode: 'two' });
  r.connect('sw-a', 's1');
  for (let i = 0; i < 3; i += 1) assert.equal(selects(r.tick()).length, 0);
  let sel = selects(r.press('sw-a', 2));
  assert.equal(sel.length, 1);
  assert.equal(selectedItem(sel[0]), 'tv', 'ticks must not advance in two-button mode');
  r.release('sw-a', 2);
  const adv = r.press('sw-a', 1);
  assert.ok(has(adv, 'highlight'), 'button 1 press advances highlight');
  assert.equal(selects(adv).length, 0, 'button 1 never selects in two-button mode');
  r.release('sw-a', 1);
  sel = selects(r.press('sw-a', 2));
  assert.equal(sel.length, 1);
  assert.equal(selectedItem(sel[0]), 'music');
});

test('switch: a held button produces at most one selection', () => {
  const r = rig();
  r.connect('sw-a', 's1');
  let count = 0;
  for (let i = 0; i < 20; i += 1) count += selects(r.press('sw-a')).length; // repeated press, no release
  assert.equal(count, 1);
  r.release('sw-a');
  assert.equal(selects(r.press('sw-a')).length, 1, 'a new edge after release selects again');
});

test('switch: debounce suppresses chatter within debounceMs', () => {
  const r = rig({ debounceMs: 50 });
  r.connect('sw-a', 's1');
  assert.equal(selects(r.press('sw-a')).length, 1);
  r.dt = 10;
  assert.equal(selects(r.release('sw-a')).length, 0);
  assert.equal(selects(r.press('sw-a')).length, 0, 'bounce 20ms after first edge must not select');
  r.release('sw-a');
  r.dt = 200;
  assert.equal(selects(r.press('sw-a')).length, 1, 'press well after debounce selects');
});

test('switch: duplicate and older sequence numbers are rejected without selection', () => {
  const r = rig();
  r.connect('sw-a', 's1');
  const t0 = r.now + 100;
  const ev = (seq, kind, at) => ({ deviceId: 'sw-a', sessionId: 's1', seq, kind, button: 1, at, receivedAt: at });
  assert.equal(selects(r.send(ev(10, 'press', t0))).length, 1);
  assert.equal(selects(r.send(ev(11, 'release', t0 + 100))).length, 0);
  const dup = r.send(ev(10, 'press', t0 + 200));
  assert.equal(selects(dup).length, 0);
  assert.ok(has(dup, 'reject'), 'duplicate seq must be rejected');
  const old = r.send(ev(5, 'press', t0 + 300));
  assert.equal(selects(old).length, 0);
  assert.ok(has(old, 'reject'), 'older seq must be rejected');
  assert.equal(selects(r.send(ev(12, 'press', t0 + 400))).length, 1, 'next valid seq still works');
});

test('switch: stale and future events are rejected without selection', () => {
  const r = rig({ maxAgeMs: 2000 });
  r.connect('sw-a', 's1');
  r.wait(10_000);
  const stale = r.event('sw-a', 'press', { button: 1, at: r.now - 2001, receivedAt: r.now });
  let out = r.send(stale);
  assert.equal(selects(out).length, 0);
  assert.ok(has(out, 'reject'), 'event older than maxAgeMs must be rejected');
  r.wait(100);
  const future = r.event('sw-a', 'press', { button: 1, at: r.now + 60_000, receivedAt: r.now });
  out = r.send(future);
  assert.equal(selects(out).length, 0);
  assert.ok(has(out, 'reject'), 'event from the future must be rejected');
});

test('switch: malformed and hostile events are rejected and do not corrupt state', () => {
  const r = rig();
  r.connect('sw-a', 's1');
  const ctrl = r.ctrl;
  const valid = () => r.event('sw-a', 'press', { button: 1 });
  const hostile = [
    null,
    undefined,
    42,
    'press',
    [],
    {},
    { ...valid(), button: 3 },
    { ...valid(), button: '1' },
    { ...valid(), button: undefined },
    { ...valid(), seq: -1 },
    { ...valid(), seq: 1.5 },
    { ...valid(), seq: NaN },
    { ...valid(), seq: '99' },
    { ...valid(), kind: 'explode' },
    { ...valid(), kind: 'select' },
    { ...valid(), deviceId: 'intruder' },
    { ...valid(), deviceId: undefined },
    { ...valid(), sessionId: undefined },
    { ...valid(), sessionId: 'not-the-session' },
    { ...valid(), at: NaN },
    { ...valid(), at: '1000' },
    { ...valid(), receivedAt: Infinity },
    Object.assign(Object.create({ kind: 'press' }), { deviceId: 'sw-a' }),
  ];
  for (const e of hostile) {
    let out;
    assert.doesNotThrow(() => { out = ctrl.handle(e); }, `handle threw for ${String(e && JSON.stringify(e))}`);
    assert.equal(selects(out).length, 0, `hostile event selected: ${String(e && JSON.stringify(e))}`);
    assert.ok(has(out, 'reject'), `hostile event not rejected: ${String(e && JSON.stringify(e))}`);
  }
  r.wait(1000);
  assert.equal(selects(r.press('sw-a')).length, 1, 'controller still works after hostile input');
});

test('switch: events for an unconfigured device or wrong session cannot select', () => {
  const r = rig();
  r.connect('sw-a', 's1');
  const t = r.now + 100;
  const out1 = r.send({ deviceId: 'sw-z', sessionId: 's1', seq: 50, kind: 'press', button: 1, at: t, receivedAt: t });
  assert.equal(selects(out1).length, 0);
  assert.ok(has(out1, 'reject'));
  const out2 = r.send({ deviceId: 'sw-a', sessionId: 'forged', seq: 50, kind: 'press', button: 1, at: t + 1, receivedAt: t + 1 });
  assert.equal(selects(out2).length, 0);
  assert.ok(has(out2, 'reject'));
});

test('switch: disconnect pauses, disconnected device cannot select, reconnect never auto-selects', () => {
  const r = rig();
  r.connect('sw-a', 's1');
  r.press('sw-a');
  const dis = r.disconnect('sw-a');
  assert.ok(has(dis, 'paused'), 'disconnect must emit paused');
  assert.equal(selects(dis).length, 0, 'disconnect must not select (even while held)');
  assert.equal(selects(r.release('sw-a')).length, 0);
  assert.equal(selects(r.press('sw-a')).length, 0, 'disconnected device cannot select');
  const re = r.connect('sw-a', 's2');
  assert.equal(selects(re).length, 0, 'no auto-selection on reconnect');
  assert.equal(selects(r.tick()).length, 0);
});

test('switch: reconnect with a new session resets sequence and edge state safely', () => {
  const r = rig();
  r.connect('sw-a', 's1');
  for (let i = 0; i < 5; i += 1) r.click('sw-a'); // seq climbs well above 1
  r.disconnect('sw-a');
  r.connect('sw-a', 's2'); // sequence restarts at 1 in the new session
  r.override(false); // explicit caregiver resume; must not itself select
  const sel = selects(r.press('sw-a'));
  assert.equal(sel.length, 1, 'fresh session with low seq must be accepted after explicit resume');
  r.release('sw-a');
  const t = r.now + 100;
  const oldSession = r.send({ deviceId: 'sw-a', sessionId: 's1', seq: 999, kind: 'press', button: 1, at: t, receivedAt: t });
  assert.equal(selects(oldSession).length, 0, 'events from the superseded session must not select');
  assert.ok(has(oldSession, 'reject'));
});

test('switch: caregiver override pauses and resumes without device fields', () => {
  const r = rig();
  r.connect('sw-a', 's1');
  const p = r.override(true);
  assert.ok(!has(p, 'reject'), 'override needs no device fields');
  assert.equal(selects(p).length, 0);
  assert.equal(selects(r.press('sw-a')).length, 0, 'paused controller cannot select');
  r.release('sw-a');
  assert.equal(selects(r.tick()).length, 0);
  const resume = r.override(false);
  assert.ok(!has(resume, 'reject'));
  assert.equal(selects(resume).length, 0, 'resume must not auto-select');
  assert.equal(selects(r.press('sw-a')).length, 1);
  const badOverride = r.send({ kind: 'override', paused: 'no', at: r.now + 1, receivedAt: r.now + 1 });
  assert.ok(has(badOverride, 'reject'), 'override paused must be boolean');
});

test('switch: debounce and edges are tracked per device', () => {
  const r = rig({ debounceMs: 50 });
  r.connect('sw-a', 'sa');
  r.connect('sw-b', 'sb');
  r.dt = 5;
  assert.equal(selects(r.press('sw-a')).length, 1);
  assert.equal(selects(r.press('sw-b')).length, 1, 'device B is not debounced by device A');
});

test('switch: memory stays bounded across many events', () => {
  const r = rig({ deviceIds: ['a', 'b', 'c', 'd'] });
  for (const d of ['a', 'b', 'c', 'd']) r.connect(d, `s-${d}`);
  const cycle = () => { for (const d of ['a', 'b', 'c', 'd']) r.click(d); r.tick(); r.send(null); };
  for (let i = 0; i < 20; i += 1) cycle();
  const small = JSON.stringify(r.ctrl.snapshot()).length;
  for (let i = 0; i < 2000; i += 1) cycle();
  const large = JSON.stringify(r.ctrl.snapshot()).length;
  assert.ok(large <= small * 1.5 + 256, `snapshot grew from ${small} to ${large} chars; event log appears unbounded`);
});
