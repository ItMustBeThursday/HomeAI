// Independent contract tests for runtime-runner.mjs (SPEC.md "Node runner and serving",
// refined by the runtime-runner header contract: options.context, plan.commands, clock, signal, maxLogBytes).
// Only injected fakes are used: no real child process, socket, timer-driven kill or file write.
import test from 'node:test';
import assert from 'node:assert/strict';

async function load(file) {
  try { return { mod: await import(file) }; } catch (error) { return { error }; }
}
const runnerLoad = await load('./runtime-runner.mjs');
const execLoad = await load('./execution-policy.mjs');
function runner() {
  if (runnerLoad.error) throw new Error(`runtime-runner.mjs could not be loaded: ${runnerLoad.error.message}`);
  for (const name of ['runPlan', 'serveArtifacts']) assert.equal(typeof runnerLoad.mod[name], 'function', `${name} export missing`);
  return runnerLoad.mod;
}
function exec() {
  if (execLoad.error) throw new Error(`execution-policy.mjs could not be loaded: ${execLoad.error.message}`);
  return execLoad.mod;
}

const isWin = process.platform === 'win32';
const ROOT = isWin ? 'D:\\HomeAI\\projects\\demo' : '/srv/homeai/demo';
const NODE = isWin ? 'C:\\Tools\\node.exe' : '/usr/bin/node';
const NPM = isWin ? 'C:\\Tools\\npm.exe' : '/usr/bin/npm';
const ARGS = Object.freeze(['--test', 'tests/unit.test.mjs']);
const unitStep = (o = {}) => ({ id: 'unit', kind: 'test', tool: 'node', args: [...ARGS], timeoutMs: 60000, ...o });
const buildStep = { id: 'build', kind: 'build', tool: 'npm', args: ['run', 'build'], timeoutMs: 120000 };
const manifest = (o = {}) => ({ version: 1, id: 'demo', projectRoot: ROOT, steps: [unitStep()], ...o });
const context = (o = {}) => ({ projectRoot: ROOT, toolPaths: { node: NODE, npm: NPM }, allowBuild: false, allowServe: false, ...o });
const planFor = (m = manifest(), c = context()) => exec().createRunPlan(m, c);
// Runs a plan with the trusted context it was built from, plus injected adapters.
const run = (plan, opts = {}, ctx = context()) => runner().runPlan(plan, { context: ctx, ...opts });

function emitter() {
  const listeners = new Map();
  const em = {
    on(n, f) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(f); return em; },
    once(n, f) { const w = (...a) => { em.off(n, w); f(...a); }; return em.on(n, w); },
    off(n, f) { const l = listeners.get(n); if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); } return em; },
    emit(n, ...a) { const l = [...(listeners.get(n) ?? [])]; for (const f of l) f(...a); return l.length > 0; },
    listenerCount(n) { return listeners.get(n)?.length ?? 0; },
    removeAllListeners(n) { if (n === undefined) listeners.clear(); else listeners.delete(n); return em; },
  };
  em.addListener = em.on;
  em.removeListener = em.off;
  em.prependListener = em.on;
  return em;
}
function stream() {
  const s = emitter();
  for (const k of ['setEncoding', 'pause', 'resume', 'destroy', 'unref', 'end']) s[k] = () => s;
  s.write = () => true;
  return s;
}
const finish = (child, code, signal = null) => { child.exitCode = code; child.emit('exit', code, signal); child.emit('close', code, signal); };
const ok = (child) => { child.stdout.emit('data', Buffer.from('ok 1\n')); finish(child, 0); };
// Fake child_process.spawn. `scripts[i]` drives the i-th child asynchronously; `onKill` decides kill behaviour.
function fakeSpawn(scripts = [ok], { closeOnKill = true } = {}) {
  const calls = [];
  const kills = [];
  const spawnImpl = (command, args, options) => {
    const index = calls.length;
    calls.push({ command, args: Array.isArray(args) ? [...args] : args, options });
    const child = emitter();
    child.stdout = stream();
    child.stderr = stream();
    child.pid = 40000 + calls.length;
    child.exitCode = null;
    child.killed = false;
    child.kill = (signal = 'SIGTERM') => {
      child.killed = true;
      kills.push(signal);
      if (closeOnKill) setImmediate(() => finish(child, null, signal));
      return true;
    };
    child.unref = () => {};
    const script = scripts[Math.min(index, scripts.length - 1)];
    setImmediate(() => script(child));
    return child;
  };
  return { spawnImpl, calls, kills };
}
const hang = () => {}; // child that never exits on its own
// Manual clock: timers fire only when advance() is called, never synchronously inside setTimeout.
function fakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { nextId += 1; timers.set(nextId, { at: now + ms, fn }); return nextId; },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
      }
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, label) {
  for (let i = 0; i < 200; i += 1) { if (predicate()) return; await tick(); }
  assert.fail(`timed out waiting for ${label}`);
}
function within(promise, ms = 5000) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms); }),
  ]);
}

test('runner: exports runPlan and serveArtifacts', () => {
  runner();
});

test('runner: valid plan spawns resolved executable with args copy, shell:false, root cwd and minimal env', async () => {
  const key = 'HOMEAI_TEST_SECRET_TOKEN';
  const prior = process.env[key];
  process.env[key] = 'do-not-leak-7f3a';
  try {
    const { spawnImpl, calls } = fakeSpawn();
    const result = await within(run(planFor(), { spawnImpl }));
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.command, NODE);
    assert.deepEqual(call.args, [...ARGS]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, ROOT);
    const env = call.options.env;
    assert.ok(env && typeof env === 'object', 'an explicit env must be passed (undefined inherits everything)');
    assert.ok(!(key in env), 'secret variable must not be forwarded');
    assert.ok(!('PATH' in env) && !('NODE_OPTIONS' in env), 'PATH/NODE_OPTIONS must not be inherited');
    assert.ok(!Object.values(env).includes('do-not-leak-7f3a'));
    assert.equal(result.status, 'passed');
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].status, 'passed');
    assert.match(result.steps[0].stdout, /ok 1/);
    assert.equal(result.artifactsReady, false, 'a test pass never makes artifacts ready');
    assert.equal(result.serveReady, false);
  } finally {
    if (prior === undefined) delete process.env[key]; else process.env[key] = prior;
  }
});

test('runner: missing or mismatched trusted context is refused before spawning', async () => {
  const plan = planFor();
  for (const opts of [{}, { context: null }, { context: context({ projectRoot: isWin ? 'D:\\HomeAI\\projects\\other' : '/srv/other' }) }]) {
    const { spawnImpl, calls } = fakeSpawn();
    await assert.rejects(() => within(runner().runPlan(plan, { ...opts, spawnImpl })));
    assert.equal(calls.length, 0);
  }
  // A build plan approved with allowBuild cannot be replayed under a context lacking that approval.
  const buildPlan = planFor(manifest({ steps: [buildStep] }), context({ allowBuild: true }));
  const { spawnImpl, calls } = fakeSpawn();
  await assert.rejects(() => within(run(buildPlan, { spawnImpl }, context({ allowBuild: false }))));
  assert.equal(calls.length, 0, 'approval must come from the trusted context, not the plan');
});

test('runner: forged or tampered plans are refused before spawning', async () => {
  const shellExe = isWin ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh';
  const tamper = [
    (p) => { p.commands[0].shell = true; },
    (p) => { p.commands[0].executable = shellExe; },
    (p) => { p.commands[0].args.push('--eval', 'process.exit(0)'); },
    (p) => { p.commands[0].args = ['--test', '../outside.test.mjs']; },
    (p) => { p.commands[0].cwd = isWin ? 'C:\\Windows' : '/etc'; },
    (p) => { p.commands[0].timeoutMs = 300001; },
    (p) => { p.commands.push({ ...p.commands[0], id: 'extra' }); },
    (p) => { p.context.allowBuild = true; },
    (p) => { p.serve = { directory: 'dist', port: 8080, host: '0.0.0.0', requiresSuccessfulBuild: false, requiresHealthCheck: false }; },
  ];
  const hostile = [null, undefined, {}, { commands: 'x' }, { commands: [{ id: 'x', executable: shellExe, args: ['/c', 'calc'], shell: true, cwd: ROOT, timeoutMs: 1000 }] }];
  for (const mutate of tamper) {
    const plan = structuredClone(planFor());
    assert.ok(Array.isArray(plan.commands), 'contract: plan.commands');
    mutate(plan);
    hostile.push(plan);
  }
  for (const plan of hostile) {
    const { spawnImpl, calls } = fakeSpawn();
    await assert.rejects(() => within(run(plan, { spawnImpl })), `hostile plan accepted: ${JSON.stringify(plan)?.slice(0, 160)}`);
    assert.equal(calls.length, 0, 'no spawn for a hostile plan');
  }
});

test('runner: invalid adapters and log bounds are refused before spawning', async () => {
  const bad = [
    { maxLogBytes: -1 }, { maxLogBytes: 1048577 }, { maxLogBytes: 1.5 },
    { clock: { now: () => 0 } }, { signal: { aborted: 'no' } },
  ];
  for (const opts of bad) {
    const { spawnImpl, calls } = fakeSpawn();
    await assert.rejects(() => within(run(planFor(), { spawnImpl, ...opts })), JSON.stringify(opts));
    assert.equal(calls.length, 0);
  }
  await assert.rejects(() => within(run(planFor(), { spawnImpl: 'spawn' })));
});

test('runner: non-zero exit fails and stops subsequent commands', async () => {
  const m = manifest({ steps: [unitStep({ id: 'first' }), unitStep({ id: 'second', args: ['--test', 'tests/b.test.mjs'] })] });
  const { spawnImpl, calls } = fakeSpawn([(child) => { child.stderr.emit('data', Buffer.from('not ok 1\n')); finish(child, 1); }, ok]);
  const result = await within(run(planFor(m), { spawnImpl }));
  assert.equal(result.status, 'failed');
  assert.equal(calls.length, 1, 'second command must not spawn after a failure');
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].code, 1);
  assert.match(result.steps[0].stderr, /not ok/);
});

test('runner: synchronous spawn failure and child error events resolve failed', async () => {
  const throwing = () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; };
  const r1 = await within(run(planFor(), { spawnImpl: throwing }));
  assert.equal(r1.status, 'failed');
  assert.match(String(r1.steps[0].error), /ENOENT/);
  const { spawnImpl } = fakeSpawn([(child) => { const e = new Error('spawn EACCES'); child.emit('error', e); }]);
  const r2 = await within(run(planFor(), { spawnImpl }));
  assert.equal(r2.status, 'failed');
});

test('runner: captured logs are bounded across the whole run and UTF-8 survives chunk splits', async () => {
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  const { spawnImpl } = fakeSpawn([(child) => {
    for (let i = 0; i < 64; i += 1) { child.stdout.emit('data', chunk); child.stderr.emit('data', chunk); }
    finish(child, 0);
  }]);
  const result = await within(run(planFor(), { spawnImpl }));
  const step = result.steps[0];
  assert.ok(Buffer.byteLength(step.stdout) + Buffer.byteLength(step.stderr) <= 65536, 'default 64 KiB bound across streams');
  assert.equal(step.truncated, true);

  const euro = Buffer.from('€', 'utf8');
  const { spawnImpl: split } = fakeSpawn([(child) => {
    child.stdout.emit('data', euro.subarray(0, 1));
    child.stdout.emit('data', euro.subarray(1));
    finish(child, 0);
  }]);
  const r2 = await within(run(planFor(), { spawnImpl: split }));
  assert.equal(r2.steps[0].stdout, '€');

  const { spawnImpl: tiny } = fakeSpawn([(child) => { child.stdout.emit('data', Buffer.from('0123456789')); finish(child, 0); }]);
  const r3 = await within(run(planFor(), { spawnImpl: tiny, maxLogBytes: 4 }));
  assert.equal(r3.steps[0].stdout, '0123');
  assert.equal(r3.steps[0].truncated, true);
});

test('runner: injected clock timeout sends SIGTERM and reports timed-out', async () => {
  const clock = fakeClock();
  const { spawnImpl, calls, kills } = fakeSpawn([hang]);
  const pending = run(planFor(), { spawnImpl, clock });
  await until(() => calls.length === 1, 'spawn');
  clock.advance(59_999);
  await tick();
  assert.deepEqual(kills, [], 'no kill before timeoutMs');
  clock.advance(1);
  const result = await within(pending);
  assert.deepEqual(kills, ['SIGTERM']);
  assert.equal(result.status, 'timed-out');
  assert.equal(result.steps[0].status, 'timed-out');
  assert.equal(result.cleanupConfirmed, true);
});

test('runner: a child ignoring SIGTERM is escalated and settles without confirmed cleanup', async () => {
  const clock = fakeClock();
  const { spawnImpl, calls, kills } = fakeSpawn([hang], { closeOnKill: false });
  const pending = run(planFor(), { spawnImpl, clock });
  await until(() => calls.length === 1, 'spawn');
  clock.advance(60_000);
  clock.advance(250);
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  clock.advance(2000);
  const result = await within(pending);
  assert.equal(result.status, 'timed-out');
  assert.equal(result.cleanupConfirmed, false, 'unobserved close must not claim cleanup');
});

test('runner: abort signal cancels the running child and later commands never spawn', async () => {
  const m = manifest({ steps: [unitStep({ id: 'first' }), unitStep({ id: 'second', args: ['--test', 'tests/b.test.mjs'] })] });
  const controller = new AbortController();
  const clock = fakeClock();
  const { spawnImpl, calls, kills } = fakeSpawn([hang, ok]);
  const pending = run(planFor(m), { spawnImpl, clock, signal: controller.signal });
  await until(() => calls.length === 1, 'spawn');
  controller.abort();
  const result = await within(pending);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(kills, ['SIGTERM']);
  assert.equal(calls.length, 1);

  const pre = new AbortController();
  pre.abort();
  const fresh = fakeSpawn();
  const r2 = await within(run(planFor(), { spawnImpl: fresh.spawnImpl, signal: pre.signal }));
  assert.equal(r2.status, 'cancelled');
  assert.equal(fresh.calls.length, 0, 'pre-aborted run must not spawn');
});

test('runner: successful injected build sets successfulBuild but never artifact/serve readiness', async () => {
  const ctx = context({ allowBuild: true, allowServe: true });
  const plan = planFor(manifest({ steps: [buildStep], serve: { directory: 'dist', port: 8080 } }), ctx);
  const { spawnImpl, calls } = fakeSpawn();
  const result = await within(run(plan, { spawnImpl }, ctx));
  assert.equal(calls[0].command, NPM);
  assert.equal(result.status, 'passed');
  assert.equal(result.successfulBuild, true);
  assert.equal(result.artifactsReady, false);
  assert.equal(result.serveReady, false);
});

test('runner: serveArtifacts refuses injected or forged run evidence before listening', async () => {
  const ctx = context({ allowBuild: true, allowServe: true });
  const plan = planFor(manifest({ steps: [buildStep], serve: { directory: 'dist', port: 8080 } }), ctx);
  const { spawnImpl } = fakeSpawn();
  const injected = await within(run(plan, { spawnImpl }, ctx));
  const forged = { ...injected, artifactsReady: true, serveReady: true };
  const attempts = [
    undefined,
    {},
    { plan, context: ctx, runResult: injected },
    { plan, context: ctx, runResult: forged },
    { plan, context: context({ allowBuild: true, allowServe: false }), runResult: injected },
    { plan: { ...plan, serve: { ...plan.serve, host: '0.0.0.0' } }, context: ctx, runResult: injected },
  ];
  for (const options of attempts) {
    let server;
    let refused = false;
    try { server = await within(runner().serveArtifacts(options), 2000); } catch { refused = true; }
    try { await server?.close?.(); } catch { /* best effort cleanup */ }
    assert.ok(refused, 'serveArtifacts must refuse without genuine module-issued run evidence');
  }
});

// Not testable offline without sockets or filesystem: real HTTP request handling (GET/HEAD only,
// no listing, MIME, symlink refusal, request bounds) and real process-group cleanup.
// Executable real HTTP and timeout coverage lives in host.test.mjs and demo/runner-smoke.mjs.
