// Independent contract tests for model-policy.mjs and execution-policy.mjs (SPEC.md, refined by CONTRACTS.md).
// Return shapes are taken from CONTRACTS.md where it fixes them; see TEST-REVIEW.md.
import test from 'node:test';
import assert from 'node:assert/strict';

async function load(file) {
  try { return { mod: await import(file) }; } catch (error) { return { error }; }
}
const modelLoad = await load('./model-policy.mjs');
const execLoad = await load('./execution-policy.mjs');
function model() {
  if (modelLoad.error) throw new Error(`model-policy.mjs could not be loaded: ${modelLoad.error.message}`);
  for (const name of ['rankCandidates', 'buildContext']) assert.equal(typeof modelLoad.mod[name], 'function', `${name} export missing`);
  return modelLoad.mod;
}
function exec() {
  if (execLoad.error) throw new Error(`execution-policy.mjs could not be loaded: ${execLoad.error.message}`);
  for (const name of ['validateManifest', 'createRunPlan', 'nextState']) assert.equal(typeof execLoad.mod[name], 'function', `${name} export missing`);
  return execLoad.mod;
}

// ---------------------------------------------------------------- model-policy

const NOW = 1_792_000_000_000;
const DIGEST = `sha256:${'ab'.repeat(32)}`;
const cand = (id, o = {}) => ({
  id, roles: ['coder'], status: 'admitted', digest: DIGEST, contextTokens: 32768, maxOutputTokens: 4096,
  quality: 0.8, latencyMs: 1000, freeVramBytes: 16e9, requiredVramBytes: 8e9, local: true, ...o,
});
const REQ = Object.freeze({ role: 'coder', inputTokens: 1000, outputTokens: 500, minQuality: 0.5, maxLatencyMs: 5000, reserveVramBytes: 1e9 });
const rank = (cands, req = REQ) => model().rankCandidates(cands, { ...req }, NOW);
const ids = (result) => { assert.ok(Array.isArray(result), 'rankCandidates must return an array'); return result.map((r) => r.id); };
function without(obj, key) { const c = { ...obj }; delete c[key]; return c; }
// Malformed input may be rejected by throwing or by exclusion; it must never be ranked.
function notRanked(cands, id, msg) {
  let result;
  try { result = rank(cands); } catch { return; }
  assert.ok(!ids(result).includes(id), msg);
}

test('model-policy: ranks by quality, then latency, then id', () => {
  const result = rank([
    cand('c', { quality: 0.7, latencyMs: 100 }),
    cand('b', { quality: 0.9, latencyMs: 900 }),
    cand('a', { quality: 0.9, latencyMs: 900 }),
    cand('d', { quality: 0.9, latencyMs: 200 }),
  ]);
  assert.deepEqual(ids(result), ['d', 'a', 'b', 'c']);
  for (const r of result) assert.ok(typeof r.reason === 'string' && r.reason.trim().length > 0, 'each result needs a reason');
});

test('model-policy: deterministic regardless of input order and does not mutate input', () => {
  const list = [cand('x', { quality: 0.6 }), cand('y', { quality: 0.95 }), cand('z', { quality: 0.6, latencyMs: 10 })];
  const snapshot = JSON.stringify(list);
  const a = ids(rank(list));
  const b = ids(rank([...list].reverse()));
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['y', 'z', 'x']);
  assert.equal(JSON.stringify(list), snapshot);
});

test('model-policy: only admitted candidates pass', () => {
  const result = ids(rank([cand('ok'), cand('cand', { status: 'candidate' }), cand('quar', { status: 'quarantined' }), cand('weird', { status: 'ADMITTED' })]));
  assert.deepEqual(result, ['ok']);
});

test('model-policy: role, context, output, quality and latency gates', () => {
  const result = ids(rank([
    cand('ok'),
    cand('role', { roles: ['vision'] }),
    cand('noroles', { roles: [] }),
    cand('ctx', { contextTokens: 900 }),
    cand('out', { maxOutputTokens: 100 }),
    cand('qual', { quality: 0.49 }),
    cand('slow', { latencyMs: 5001 }),
  ]));
  assert.deepEqual(result, ['ok']);
});

test('model-policy: thresholds are inclusive', () => {
  const result = ids(rank([cand('edge', { contextTokens: 1500, maxOutputTokens: 500, quality: 0.5, latencyMs: 5000, freeVramBytes: 9e9, requiredVramBytes: 8e9 })]));
  assert.deepEqual(result, ['edge']);
});

test('model-policy: VRAM must cover requirement plus reserve for local models', () => {
  const result = ids(rank([
    cand('ok', { freeVramBytes: 12e9, requiredVramBytes: 8e9 }),
    cand('short', { freeVramBytes: 7e9, requiredVramBytes: 8e9 }),
    cand('reserve', { freeVramBytes: 8.5e9, requiredVramBytes: 8e9 }), // fits only if reserve ignored
  ]));
  assert.deepEqual(result, ['ok']);
});

test('model-policy: unknown required metrics exclude instead of defaulting to zero', () => {
  const base = cand('known');
  const unknowns = [
    ['no-latency', without(base, 'latencyMs')],
    ['null-latency', { ...base, latencyMs: null }],
    ['no-quality', without(base, 'quality')],
    ['no-context', without(base, 'contextTokens')],
    ['no-maxout', without(base, 'maxOutputTokens')],
    ['no-free-vram', without(base, 'freeVramBytes')],
    ['no-req-vram', without(base, 'requiredVramBytes')],
    ['no-digest', without(base, 'digest')],
    ['empty-digest', { ...base, digest: '' }],
  ];
  for (const [id, c] of unknowns) {
    let result;
    assert.doesNotThrow(() => { result = rank([cand('known'), { ...c, id }]); }, `unknown metric (${id}) should exclude, not throw`);
    assert.deepEqual(ids(result), ['known'], `${id} must be excluded`);
  }
});

test('model-policy: malformed metric values are never ranked', () => {
  const bad = [
    ['nan-quality', { quality: NaN }], ['big-quality', { quality: 1.5 }], ['neg-quality', { quality: -0.1 }],
    ['str-quality', { quality: '0.9' }], ['neg-latency', { latencyMs: -1 }], ['inf-latency', { latencyMs: Infinity }],
    ['str-ctx', { contextTokens: '32768' }], ['frac-ctx', { contextTokens: 1000.5 }], ['neg-vram', { freeVramBytes: -1 }],
    ['roles-string', { roles: 'coder' }], ['local-string', { local: 'yes' }], ['digest-number', { digest: 12345 }],
    ['digest-short', { digest: 'sha256:abc' }], ['digest-upper-prefix', { digest: `SHA256:${'ab'.repeat(32)}` }],
  ];
  for (const [id, patch] of bad) notRanked([cand('fine'), cand(id, patch)], id, `${id} must not be ranked`);
});

test('model-policy: malformed request, candidate list or duplicate ids throw', () => {
  const { rankCandidates } = model();
  assert.throws(() => rankCandidates(null, { ...REQ }, NOW));
  assert.throws(() => rankCandidates('x', { ...REQ }, NOW));
  assert.throws(() => rankCandidates([cand('a')], null, NOW));
  assert.throws(() => rankCandidates([cand('a'), cand('a')], { ...REQ }, NOW), TypeError, 'duplicate ids are ambiguous');
  for (const patch of [{ role: '' }, { role: undefined }, { inputTokens: -1 }, { outputTokens: 1.5 }, { minQuality: 2 }, { maxLatencyMs: NaN }, { reserveVramBytes: -1 }]) {
    assert.throws(() => rankCandidates([cand('a')], { ...REQ, ...patch }, NOW), `request should be refused: ${JSON.stringify(patch)}`);
  }
  for (const c of [null, 5, 'a']) notRanked([cand('fine'), c], undefined, 'non-object candidates are not ranked');
});

test('model-policy: empty candidate list yields empty ranking', () => {
  assert.deepEqual(rank([]), []);
});

// buildContext

const item = (id, tokens, o = {}) => ({ id, text: `text-${id}`, tokens, required: false, priority: 0, ...o });
const idOf = (x) => (typeof x === 'string' ? x : x.id);
function ctx(items, budget) {
  const r = model().buildContext(items, budget);
  assert.ok(r && Array.isArray(r.included) && Array.isArray(r.excluded), 'buildContext must report included and excluded');
  assert.ok(Number.isInteger(r.usedTokens), 'usedTokens must be an integer');
  return { ...r, inc: r.included.map(idOf), exc: r.excluded.map(idOf) };
}

test('context: required items always kept, optional chosen by priority as whole items', () => {
  const items = [
    item('sys', 4, { required: true, priority: -100 }),
    item('big', 8, { priority: 9 }),
    item('mid', 3, { priority: 5 }),
    item('low', 3, { priority: 1 }),
  ];
  const r = ctx(items, 10);
  assert.deepEqual(r.inc, ['sys', 'mid', 'low'], 'required first, then optional by priority');
  assert.deepEqual(r.exc, ['big'], 'oversized item is excluded whole, not truncated, and does not block smaller ones');
  assert.equal(r.usedTokens, 10);
});

test('context: higher priority wins when both cannot fit; ties break by id', () => {
  const r = ctx([item('a', 6, { priority: 1 }), item('b', 6, { priority: 2 })], 10);
  assert.deepEqual(r.inc, ['b']);
  assert.deepEqual(r.exc, ['a']);
  assert.equal(r.usedTokens, 6);
  const tie = ctx([item('z', 6, { priority: 1 }), item('m', 6, { priority: 1 })], 10);
  assert.deepEqual(tie.inc, ['m']);
});

test('context: required text is never truncated and results are detached', () => {
  const long = 'x'.repeat(500);
  const items = [item('req', 9, { required: true, text: long }), item('opt', 5, { priority: 3 })];
  const r = model().buildContext(items, 10);
  const req = r.included.find((x) => idOf(x) === 'req');
  assert.ok(req);
  assert.equal(req.text, long);
  req.text = 'mutated';
  assert.equal(items[0].text, long, 'returned items must be detached copies');
});

test('context: required items exceeding the budget throw', () => {
  assert.throws(() => model().buildContext([item('r1', 6, { required: true }), item('r2', 6, { required: true })], 10), RangeError);
});

test('context: identical duplicates are de-duplicated, conflicting duplicates throw', () => {
  const r = ctx([item('a', 3, { priority: 1 }), item('a', 3, { priority: 1 }), item('b', 2)], 10);
  assert.equal(r.inc.filter((x) => x === 'a').length, 1);
  assert.equal(r.usedTokens, 5);
  assert.throws(() => model().buildContext([item('a', 3), item('a', 3, { text: 'different' })], 10));
  assert.throws(() => model().buildContext([item('a', 3), item('a', 4)], 10));
  assert.throws(() => model().buildContext([item('a', 3), item('a', 3, { required: true })], 10), 'required flag conflict');
});

test('context: invalid budget and malformed items throw', () => {
  const { buildContext } = model();
  for (const budget of [0, -1, 1.5, NaN, Infinity, '10', undefined]) assert.throws(() => buildContext([item('a', 1)], budget), `budget ${String(budget)}`);
  for (const bad of [item('a', -1), item('a', 1.5), item('a', NaN), item('a', '3'), { ...item('a', 1), id: '' }, { ...item('a', 1), text: 5 },
    { ...item('a', 1), required: 'yes' }, { ...item('a', 1), priority: NaN }, null]) {
    assert.throws(() => buildContext([bad], 10), `item should be refused: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => buildContext(null, 10));
});

test('context: does not mutate caller items', () => {
  const items = [item('a', 3, { required: true }), item('b', 20, { priority: 1 })];
  const before = JSON.stringify(items);
  ctx(items, 10);
  assert.equal(JSON.stringify(items), before);
});

// ------------------------------------------------------------ execution-policy

const isWin = process.platform === 'win32';
const ROOT = isWin ? 'D:\\HomeAI\\projects\\demo' : '/srv/homeai/demo';
const bin = (n) => (isWin ? `C:\\Tools\\${n}.exe` : `/usr/bin/${n}`);
const TOOLS = Object.freeze({ node: bin('node'), npm: bin('npm'), dotnet: bin('dotnet'), cargo: bin('cargo'), cmake: bin('cmake') });
const testStep = (o = {}) => ({ id: 'unit', kind: 'test', tool: 'node', args: ['--test', 'tests/unit.test.mjs'], timeoutMs: 60000, ...o });
const BUILD = Object.freeze({ id: 'build', kind: 'build', tool: 'npm', args: ['run', 'build'], timeoutMs: 120000 });
const manifest = (o = {}) => ({ version: 1, id: 'demo', projectRoot: ROOT, steps: [testStep()], ...o });
const serveManifest = (serve) => manifest({ steps: [{ ...BUILD, args: [...BUILD.args] }], serve });
const context = (o = {}) => ({ projectRoot: ROOT, toolPaths: { ...TOOLS }, allowBuild: false, allowServe: false, ...o });

// CONTRACTS.md: validateManifest/createRunPlan throw TypeError on rejection.
function rejected(fn) {
  try { fn(); return false; } catch (error) { assert.ok(error instanceof TypeError, `expected TypeError, got ${error?.name}: ${error?.message}`); return true; }
}
const manifestRejected = (m) => rejected(() => exec().validateManifest(m));
const planRejected = (m, c = context()) => rejected(() => exec().createRunPlan(m, c));

test('execution-policy: a minimal safe node test manifest is accepted and returned detached', () => {
  const m = manifest();
  const v = exec().validateManifest(m);
  assert.deepEqual(v, { version: 1, id: 'demo', projectRoot: ROOT, steps: [testStep()] });
  assert.notEqual(v.steps[0].args, m.steps[0].args);
  assert.ok(!planRejected(manifest()));
  assert.ok(!manifestRejected(serveManifest({ directory: 'dist', port: 8080 })), 'serve with a build step is valid');
  assert.ok(!manifestRejected(serveManifest({ directory: 'out/site', port: 65535 })));
});

test('execution-policy: manifest structure violations are rejected', () => {
  const bad = [
    null, {}, manifest({ version: 2 }), manifest({ version: '1' }), manifest({ id: '' }), manifest({ id: undefined }), manifest({ id: '../x' }),
    manifest({ steps: [] }), manifest({ steps: 'x' }), manifest({ steps: Array.from({ length: 129 }, (_, i) => testStep({ id: `s${i}` })) }),
    manifest({ steps: [testStep(), testStep()] }),
    manifest({ steps: [testStep({ id: '' })] }),
    manifest({ steps: [testStep({ kind: 'deploy' })] }),
    manifest({ steps: [testStep({ tool: 'bash' })] }),
    manifest({ steps: [testStep({ tool: 'powershell' })] }),
    manifest({ steps: [testStep({ tool: 'python' })] }),
  ];
  for (const m of bad) assert.ok(manifestRejected(m), `should reject ${JSON.stringify(m)?.slice(0, 120)}`);
});

test('execution-policy: unbounded or invalid timeouts are rejected', () => {
  for (const timeoutMs of [undefined, 0, -1, 300001, Infinity, NaN, 1.5, '60000']) {
    assert.ok(manifestRejected(manifest({ steps: [testStep({ timeoutMs })] })), `timeout ${String(timeoutMs)}`);
  }
  assert.ok(!manifestRejected(manifest({ steps: [testStep({ timeoutMs: 300000 })] })), 'max 300000 is allowed');
  assert.ok(!manifestRejected(manifest({ steps: [testStep({ timeoutMs: 1 })] })));
});

test('execution-policy: shell operators, NUL and unbounded args are rejected', () => {
  const badArgs = [
    [], undefined, 'tests/unit.test.mjs', ['--test', 5], ['--test', '   '],
    ['--test', 'a.test.mjs;calc'], ['--test', 'a.test.mjs && calc'], ['--test', 'a.test.mjs|calc'],
    ['--test', '`calc`'], ['--test', '$(calc).test.mjs'], ['--test', 'a.test.mjs>out.txt'], ['--test', 'a.test.mjs<in'],
    ['--test', 'a.test.mjs\u0000'], ['--test', 'a.test.mjs\ncalc'], ['--test', 'a.test.mjs\u007f'],
    ['--test', ...Array.from({ length: 64 }, (_, i) => `t${i}.test.mjs`)],
    ['--test', `${'a'.repeat(5000)}.test.mjs`],
  ];
  for (const args of badArgs) assert.ok(manifestRejected(manifest({ steps: [testStep({ args })] })), `args ${JSON.stringify(args)?.slice(0, 80)}`);
});

test('execution-policy: build args reject absolute, traversal and device operands, including after "="', () => {
  for (const args of [['run', '../x'], ['--out=/etc/x'], ['--out=C:\\x'], ['build', 'dist/../../x'], ['--log=NUL'], ['\\\\server\\share']]) {
    assert.ok(manifestRejected(manifest({ steps: [{ ...BUILD, args }] })), `build args ${JSON.stringify(args)}`);
  }
  assert.ok(!manifestRejected(manifest({ steps: [{ ...BUILD, args: ['run', 'build', '--out=dist/site'] }] })));
});

test('execution-policy: node test args allow only --test and safe relative .test.mjs targets', () => {
  const bad = [
    ['--test'], ['--test', '--eval', 'process.exit(0)'], ['--test', '-e', '1'], ['--test', '-p', '1'], ['--test', '--print', '1'],
    ['--test', '--import', './evil.mjs', 'a.test.mjs'], ['--test', '--import=./evil.mjs', 'a.test.mjs'],
    ['--test', '--require', './evil.cjs', 'a.test.mjs'], ['--test', '-r', './evil.cjs', 'a.test.mjs'],
    ['--test', '--loader', './l.mjs', 'a.test.mjs'], ['--test', '--experimental-loader=./l.mjs', 'a.test.mjs'],
    ['--test', '--inspect', 'a.test.mjs'], ['--test', '--allow-child-process', 'a.test.mjs'],
    ['--test', '--env-file=.env', 'a.test.mjs'], ['--test', '--test-reporter-destination=/tmp/x', 'a.test.mjs'],
    ['a.test.mjs'], ['--run', 'test'], ['a.test.mjs', '--test'],
    ['--test', 'evil.mjs'], ['--test', 'a.test.js'], ['--test', 'a.test.mjs.exe'], ['--test', '-a.test.mjs'],
    ['--test', '../outside.test.mjs'], ['--test', 'tests/../../outside.test.mjs'], ['--test', 'tests\\..\\..\\outside.test.mjs'],
    ['--test', './a.test.mjs'], ['--test', 'tests//a.test.mjs'],
    ['--test', isWin ? 'C:\\x\\a.test.mjs' : '/tmp/a.test.mjs'], ['--test', '/tmp/a.test.mjs'], ['--test', 'C:a.test.mjs'],
    ['--test', '\\\\server\\share\\a.test.mjs'], ['--test', '\\\\?\\C:\\a.test.mjs'], ['--test', '\\\\.\\pipe\\a.test.mjs'],
    ['--test', 'file:///tmp/a.test.mjs'], ['--test', 'data:text/javascript,1//.test.mjs'], ['--test', 'CON/a.test.mjs'],
  ];
  for (const args of bad) assert.ok(manifestRejected(manifest({ steps: [testStep({ args })] })), `node args ${JSON.stringify(args)}`);
  for (const args of [['--test', 'a.test.mjs'], ['--test', 'tests/unit.test.mjs'], ['--test', 'tests/a.test.mjs', 'tests/b.test.mjs']]) {
    assert.ok(!manifestRejected(manifest({ steps: [testStep({ args })] })), `node args ${JSON.stringify(args)} should be allowed`);
  }
});

test('execution-policy: project root must be local absolute and match context', () => {
  for (const projectRoot of ['relative\\dir', './demo', '', '\\\\server\\share\\demo', '\\\\?\\D:\\demo', '\\\\.\\D:\\demo', `${ROOT}\u0000`, 'D:demo', 'demo',
    isWin ? 'D:\\HomeAI\\..\\Windows' : '/srv/../etc', isWin ? 'D:\\HomeAI\\CON' : '/srv/CON', isWin ? 'D:\\Home*' : '/srv/*']) {
    assert.ok(manifestRejected(manifest({ projectRoot })), `root ${JSON.stringify(projectRoot)}`);
  }
  const other = isWin ? 'D:\\HomeAI\\projects\\other' : '/srv/homeai/other';
  assert.ok(planRejected(manifest(), context({ projectRoot: other })), 'manifest/context root mismatch');
  if (isWin) assert.ok(!planRejected(manifest(), context({ projectRoot: 'd:/homeai/projects/demo/' })), 'windows roots compare case-insensitively with slash normalization');
});

test('execution-policy: serve directory traversal, absolute, UNC and device paths are rejected', () => {
  const dirs = ['../dist', 'dist/../../x', 'dist\\..\\..\\x', '..', '.', './dist', ROOT, isWin ? 'C:\\Windows' : '/etc', '/etc', 'C:dist',
    '\\\\server\\share', '\\\\?\\C:\\dist', '\\\\.\\COM1', 'dist\u0000', '', 'CON', 'dist/NUL', 'dist//x', 'dist*', 'dist.', 5, undefined];
  for (const directory of dirs) {
    assert.ok(manifestRejected(serveManifest({ directory, port: 8080 })), `serve dir ${JSON.stringify(directory)}`);
  }
  for (const port of [0, -1, 65536, 70000, 80.5, '8080', undefined]) {
    assert.ok(manifestRejected(serveManifest({ directory: 'dist', port })), `serve port ${String(port)}`);
  }
  assert.ok(manifestRejected(manifest({ serve: { directory: 'dist', port: 8080 } })), 'test-only manifests cannot serve');
  assert.ok(manifestRejected(serveManifest(null)), 'null serve declaration');
});

test('execution-policy: builds and non-node tools require allowBuild, serve requires allowServe', () => {
  const npmTest = { id: 'npmtest', kind: 'test', tool: 'npm', args: ['test'], timeoutMs: 120000 };
  const dotnetTest = { id: 'dn', kind: 'test', tool: 'dotnet', args: ['test'], timeoutMs: 120000 };
  const cargoTest = { id: 'cg', kind: 'test', tool: 'cargo', args: ['test'], timeoutMs: 120000 };
  const compile = { id: 'cm', kind: 'compile', tool: 'cmake', args: ['--build', 'build'], timeoutMs: 120000 };
  for (const step of [BUILD, npmTest, dotnetTest, cargoTest, compile]) {
    const m = manifest({ steps: [{ ...step, args: [...step.args] }] });
    assert.ok(planRejected(m, context({ allowBuild: false })), `${step.id} must require allowBuild`);
    assert.ok(!planRejected(m, context({ allowBuild: true })), `${step.id} allowed with allowBuild`);
  }
  const nodeBuild = manifest({ steps: [testStep({ id: 'nb', kind: 'build' })] });
  assert.ok(planRejected(nodeBuild, context({ allowBuild: false })), 'non-test node step requires allowBuild');
  const served = serveManifest({ directory: 'dist', port: 8080 });
  assert.ok(planRejected(served, context({ allowBuild: true, allowServe: false })), 'serve requires allowServe');
  assert.ok(!planRejected(served, context({ allowBuild: true, allowServe: true })));
  for (const flags of [{ allowBuild: undefined }, { allowServe: 'yes' }, { allowBuild: 1 }]) {
    assert.ok(planRejected(manifest(), context(flags)), `approval flags must be explicit booleans: ${JSON.stringify(flags)}`);
  }
});

test('execution-policy: tool paths must be own-property local absolute executables', () => {
  for (const node of [undefined, '', 'node', '.\\node.exe', './node', '\\\\server\\share\\node.exe', `${TOOLS.node}\u0000`, isWin ? 'C:\\Tools\\..\\node.exe' : '/usr/../node']) {
    assert.ok(planRejected(manifest(), context({ toolPaths: { ...TOOLS, node } })), `tool path ${JSON.stringify(node)}`);
  }
  assert.ok(planRejected(manifest(), context({ toolPaths: null })));
  assert.ok(planRejected(manifest(), context({ toolPaths: Object.create({ node: TOOLS.node }) })), 'inherited tool path must not count');
});

test('execution-policy: plan matches the documented command shape', () => {
  const plan = exec().createRunPlan(manifest(), context());
  assert.equal(plan.version, 1);
  assert.equal(plan.serve, null);
  assert.deepEqual(plan.commands, [{
    id: 'unit', kind: 'test', tool: 'node', args: ['--test', 'tests/unit.test.mjs'], timeoutMs: 60000,
    executable: TOOLS.node, shell: false, cwd: ROOT,
  }]);
  assert.deepEqual(plan.context, { projectRoot: ROOT, toolPaths: { node: TOOLS.node }, allowBuild: false, allowServe: false }, 'only used tool paths are carried');
  assert.notEqual(plan.commands[0].args, plan.manifest.steps[0].args, 'command args are copied independently');
});

test('execution-policy: serve plan is localhost-only and requires build plus health check', () => {
  const plan = exec().createRunPlan(serveManifest({ directory: 'dist', port: 8080 }), context({ allowBuild: true, allowServe: true }));
  assert.deepEqual(plan.serve, { directory: 'dist', port: 8080, host: '127.0.0.1', requiresSuccessfulBuild: true, requiresHealthCheck: true });
});

test('execution-policy: validation and planning do not mutate or alias the caller manifest', () => {
  const m = manifest();
  const before = JSON.stringify(m);
  exec().validateManifest(m);
  const plan = exec().createRunPlan(m, context());
  assert.equal(JSON.stringify(m), before);
  plan.commands[0].args.push('--eval');
  assert.deepEqual(m.steps[0].args, ['--test', 'tests/unit.test.mjs'], 'plan args must not alias manifest args');
});

// nextState (CONTRACTS.md transition table)

const next = (state, event) => exec().nextState(state, event);
const TERMINAL = ['passed', 'failed', 'cancelled', 'timed-out'];
const EVENTS = [{ type: 'start' }, { type: 'pass' }, { type: 'fail' }, { type: 'timeout' }, { type: 'cancel' }, { type: 'buildSucceeded', kind: 'build' }];

test('nextState: queued -> running -> each terminal status', () => {
  const running = next({ status: 'queued' }, { type: 'start' });
  assert.equal(running.status, 'running');
  assert.equal(next(running, { type: 'pass' }).status, 'passed');
  assert.equal(next(running, { type: 'fail' }).status, 'failed');
  assert.equal(next(running, { type: 'timeout' }).status, 'timed-out');
  assert.equal(next(running, { type: 'cancel' }).status, 'cancelled');
  assert.equal(next({ status: 'queued' }, { type: 'cancel' }).status, 'cancelled', 'a queued job can be cancelled');
});

test('nextState: is pure, returns a new object and preserves caller metadata', () => {
  const state = Object.freeze({ status: 'queued', jobId: 'j-1', note: 'x' });
  const out = next(state, { type: 'start' });
  assert.notEqual(out, state);
  assert.equal(state.status, 'queued');
  assert.equal(out.jobId, 'j-1');
  assert.equal(out.note, 'x');
});

test('nextState: terminal statuses never restart or change', () => {
  for (const status of TERMINAL) {
    for (const event of EVENTS) {
      assert.throws(() => next({ status }, event), TypeError, `${status} + ${event.type} must throw`);
    }
  }
});

test('nextState: invalid transitions and malformed input throw TypeError', () => {
  const cases = [
    [{ status: 'queued' }, { type: 'pass' }], [{ status: 'queued' }, { type: 'fail' }], [{ status: 'queued' }, { type: 'timeout' }],
    [{ status: 'queued' }, { type: 'buildSucceeded', kind: 'build' }], [{ status: 'running' }, { type: 'start' }],
    [{ status: 'running' }, { type: 'buildSucceeded', kind: 'test' }], [{ status: 'running' }, { type: 'buildSucceeded' }],
    [{ status: 'running' }, { type: 'explode' }], [{ status: 'running' }, { kind: 'pass' }], [{ status: 'running' }, null],
    [{ status: 'bogus' }, { type: 'start' }], [null, { type: 'start' }], [[], { type: 'start' }],
    [{ status: 'queued', successfulBuild: 'yes' }, { type: 'start' }],
  ];
  for (const [state, event] of cases) assert.throws(() => next(state, event), TypeError, `${JSON.stringify(state)} + ${JSON.stringify(event)}`);
});

test('nextState: readiness only after explicit successful build, pass and an independent health check', () => {
  let s = next({ status: 'queued' }, { type: 'start' });
  s = next(s, { type: 'buildSucceeded', kind: 'build' });
  assert.equal(s.successfulBuild, true);
  assert.equal(s.artifactsReady, false, 'build success alone is not readiness');
  s = next(s, { type: 'pass' });
  assert.equal(s.status, 'passed');
  assert.equal(s.artifactsReady, false, 'pass alone is not readiness');
  assert.equal(s.serveReady, false);
  const healthy = next(s, { type: 'healthChecked', ok: true });
  assert.equal(healthy.artifactsReady, true);
  assert.equal(healthy.serveReady, true);
  const unhealthy = next(healthy, { type: 'healthChecked', ok: false });
  assert.equal(unhealthy.artifactsReady, false, 'a later failed health check withdraws readiness');
  assert.equal(unhealthy.serveReady, false);
  assert.throws(() => next(s, { type: 'healthChecked', ok: 'yes' }), TypeError);
  assert.throws(() => next(s, { type: 'healthChecked' }), TypeError);
});

test('nextState: test pass without build, or failed/cancelled/timed-out runs, can never become ready', () => {
  const testOnly = next(next({ status: 'queued' }, { type: 'start' }), { type: 'pass' });
  assert.throws(() => next(testOnly, { type: 'healthChecked', ok: true }), TypeError, 'test pass alone cannot reach readiness');
  for (const terminal of ['fail', 'timeout', 'cancel']) {
    const built = next(next({ status: 'queued' }, { type: 'start' }), { type: 'buildSucceeded', kind: 'compile' });
    const ended = next(built, { type: terminal });
    assert.equal(ended.artifactsReady, false);
    assert.throws(() => next(ended, { type: 'healthChecked', ok: true }), TypeError, `health check cannot rescue ${ended.status}`);
  }
  assert.throws(() => next(next({ status: 'queued' }, { type: 'start' }), { type: 'healthChecked', ok: true }), TypeError, 'health check while running');
});

test('nextState: forged readiness in the input state is refused; start clears stale evidence', () => {
  for (const state of [
    { status: 'running', artifactsReady: true }, { status: 'passed', serveReady: true },
    { status: 'passed', successfulBuild: false, artifactsReady: true }, { status: 'failed', successfulBuild: true, artifactsReady: true },
  ]) {
    assert.throws(() => next(state, { type: 'cancel' }), TypeError, JSON.stringify(state));
  }
  const started = next({ status: 'queued', successfulBuild: true }, { type: 'start' });
  assert.equal(started.successfulBuild, false, 'evidence from before start must not carry into the run');
});
