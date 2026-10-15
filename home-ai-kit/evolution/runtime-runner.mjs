/**
 * Additive Node >=24 runner. No import-time execution; NOT a security sandbox.
 *
 * runPlan(plan, options) -> Promise<{status,successfulBuild,artifactsReady:false,
 *   serveReady:false,steps,startedAt,finishedAt,cleanupConfirmed}>
 *
 * REQUIRED options.context is the caller's independently trusted execution context,
 * not approval copied from untrusted plan.context. The entire plan is reconstructed
 * and compared before any effect. Caller must authenticate approval and tool paths.
 *
 * Test adapters: spawnImpl(executable,args,options) returns an EventEmitter child
 * with stdout/stderr emitters, kill(signal), and error/close events;
 * clock={now,setTimeout,clearTimeout}; signal is an AbortSignal.
 * Adapter events must be asynchronous after spawn returns. maxLogBytes bounds
 * captured raw stdout+stderr bytes across the whole run (default65536, max1MiB).
 * UTF-8 is decoded once per stream, preserving characters split across chunks.
 * No sockets/processes are needed by adapter tests. Injected results are not
 * independent health proof. Successful builds alone never mark artifacts ready.
 *
 * Real POSIX children use a dedicated process group, terminated on stop/close.
 * Windows and injected adapters kill the direct child only. Escaped descendants
 * are NOT contained. cleanupConfirmed means direct-child close observed only.
 * Static serving snapshots bounded artifacts after a genuine successful run.
 * Real spawns preflight canonical directories, regular single-link tools and node
 * test entry files. These checks are not atomic with spawn or code imports.
 * Injected spawnImpl skips filesystem preflight and cannot authorize serving.
 *
 * Test/API example (no execution on import):
 *   const plan = createRunPlan(manifest, trustedContext);
 *   const result = await runPlan(plan, {context: trustedContext, spawnImpl: fakeSpawn});
 * Plan command fields live in plan.commands, not plan.steps. Malformed/tampered
 * plans and missing approvals reject before spawning. Execution failures resolve
 * with status failed/cancelled/timed-out and stop subsequent commands. A completed
 * earlier step may remain passed even when the overall result.status is failed.
 * Use AbortController.signal for cancellation. Fake clock callbacks must be
 * scheduled, not invoked synchronously inside setTimeout. Timeout sends SIGTERM,
 * then SIGKILL after250ms; unobserved close settles after2000ms with
 * cleanupConfirmed=false. Spawn adapters should emit close when cleanup completes.
 * Snapshot errors resolve failed/cancelled with artifactSnapshotError.
 * Required runtime exports: runPlan and serveArtifacts. No test-only execution
 * bypass is provided: inject a fake spawn AND supply independently trusted context.
 */
import path from 'node:path';
import {lstat, opendir, realpath, open, access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createServer, get} from 'node:http';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {createRunPlan} from './execution-policy.mjs';

// Private provenance: serialized, cloned, modified or injected results cannot authorize serving.
const completedRuns = new WeakMap();
const defaultClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: timer => clearTimeout(timer)
};

function minimalEnvironment() {
  const env = Object.create(null);
  // No PATH, NODE_OPTIONS, npm configuration, credentials or inherited user env.
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

function execute(command, {spawnImpl, clock, signal, budget}) {
  return new Promise(resolve => {
    let child, timeout, escalation, deadline, done = false;
    let stopped = null, error = null, truncated = false;
    const output = {stdout: Buffer.alloc(budget.remaining), stderr: Buffer.alloc(budget.remaining)};
    const lengths = {stdout: 0, stderr: 0};
    const group = spawnImpl === spawn && process.platform !== 'win32';
    const startedAt = clock.now();
    const capture = stream => chunk => {
      if (done) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const take = Math.min(bytes.length, budget.remaining);
      budget.remaining -= take;
      if (take < bytes.length) truncated = true;
      bytes.copy(output[stream], lengths[stream], 0, take);
      lengths[stream] += take;
    };
    const finish = (code, terminationSignal, cleanupConfirmed) => {
      if (done) return;
      done = true;
      // Kill any members remaining in the original POSIX process group even if
      // the leader closed early. A process that created a new session may escape.
      if (group && child?.pid) kill('SIGKILL');
      if (!cleanupConfirmed) {
        child?.stdout?.destroy?.();
        child?.stderr?.destroy?.();
        child?.unref?.();
      }
      for (const timer of [timeout, escalation, deadline]) {
        if (timer !== undefined) clock.clearTimeout(timer);
      }
      signal?.removeEventListener('abort', abort);
      resolve({
        id: command.id, kind: command.kind,
        status: stopped || (error || code !== 0 ? 'failed' : 'passed'),
        code: Number.isInteger(code) ? code : null,
        signal: terminationSignal || null, error,
        stdout: output.stdout.subarray(0, lengths.stdout).toString('utf8'),
        stderr: output.stderr.subarray(0, lengths.stderr).toString('utf8'),
        truncated, cleanupConfirmed,
        cleanupScope: group ? 'direct-child; process-group kill attempted' : 'direct-child only',
        startedAt, finishedAt: clock.now()
      });
    };
    const kill = sig => {
      try {
        if (group && child?.pid) process.kill(-child.pid, sig);
        else child?.kill(sig);
      } catch (cause) {
        if (cause.code !== 'ESRCH') error = String(cause.message || cause).slice(0, 1024);
      }
    };
    const stop = status => {
      if (done || stopped) return;
      stopped = status;
      // Timers are registered before kill, permitting synchronous fake adapters.
      escalation = clock.setTimeout(() => kill('SIGKILL'), 250);
      deadline = clock.setTimeout(() => finish(null, null, false), 2000);
      kill('SIGTERM');
    };
    const abort = () => stop('cancelled');
    if (signal?.aborted) {
      stopped = 'cancelled';
      finish(null, null, true);
      return;
    }
    try {
      // Node's default test isolation forks one child per file. Run supported
      // Node tests in-process so Windows timeout/cancel cannot orphan that fork.
      // Arbitrary build code can still spawn descendants: this is not containment.
      const args = spawnImpl === spawn && command.tool === 'node' && command.kind === 'test'
        ? [command.args[0], '--test-isolation=none', ...command.args.slice(1)] : [...command.args];
      child = spawnImpl(command.executable, args, {
        cwd: command.cwd, shell: false, windowsHide: true, detached: group,
        env: minimalEnvironment(), stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout?.on('error', cause => {
        error = String(cause.message || cause).slice(0, 1024); stop('failed');
      });
      child.stderr?.on('error', cause => {
        error = String(cause.message || cause).slice(0, 1024); stop('failed');
      });
      child.stdout?.on('data', capture('stdout'));
      child.stderr?.on('data', capture('stderr'));
      child.on('error', cause => {
        error = String(cause.message || cause).slice(0, 1024);
        stop('failed');
      });
      child.once('close', (code, sig) => finish(code, sig, true));
      timeout = clock.setTimeout(() => stop('timed-out'), command.timeoutMs);
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
    } catch (cause) {
      error = String(cause.message || cause).slice(0, 1024);
      if (child) stop('failed');
      else finish(null, null, true);
    }
  });
}

export async function runPlan(plan, options = {}) {
  if (!options.context) throw new TypeError('Independent trusted context required');
  const rebuilt = createRunPlan(plan?.manifest, options.context);
  if (!isDeepStrictEqual(plan, rebuilt)) throw new TypeError('Forged or stale run plan');
  const spawnImpl = options.spawnImpl ?? spawn;
  const clock = options.clock ?? defaultClock;
  if (typeof spawnImpl !== 'function' ||
      !['now','setTimeout','clearTimeout'].every(key => typeof clock[key] === 'function'))
    throw new TypeError('Invalid runner adapter');
  const maxLogBytes = options.maxLogBytes ?? 65536;
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes < 0 || maxLogBytes > 1048576)
    throw new TypeError('Invalid log bound');
  const signal = options.signal;
  if (signal && (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')) throw new TypeError('Invalid signal');
  const budget = {remaining: maxLogBytes};
  const result = {
    status: 'running', successfulBuild: false, artifactsReady: false,
    serveReady: false, steps: [], startedAt: clock.now(), finishedAt: null,
    cleanupConfirmed: true
  };
  for (const command of rebuilt.commands) {
    if (spawnImpl === spawn && !signal?.aborted) {
      try { await preflightCommand(command); }
      catch (error) {
        result.steps.push({id: command.id, kind: command.kind, status: 'failed',
          code: null, signal: null, error: String(error.message || error).slice(0, 1024),
          stdout: '', stderr: '', truncated: false, cleanupConfirmed: true,
          cleanupScope: 'no child spawned', startedAt: clock.now(), finishedAt: clock.now()});
        result.status = 'failed';
        break;
      }
    }
    const step = await execute(command, {spawnImpl, clock, signal, budget});
    result.steps.push(step);
    result.cleanupConfirmed &&= step.cleanupConfirmed;
    if (step.status !== 'passed') {
      result.status = step.status;
      break;
    }
    if (command.kind === 'build' || command.kind === 'compile') result.successfulBuild = true;
  }
  if (result.status === 'running') result.status = signal?.aborted ? 'cancelled' : 'passed';
  let files = null;
  if (spawnImpl === spawn && clock === defaultClock && result.status === 'passed' &&
      result.successfulBuild && result.cleanupConfirmed && rebuilt.serve) {
    try {
      const root = await checkedDirectory(rebuilt.projectRoot);
      const directory = path.resolve(root, ...rebuilt.serve.directory.split(/[\\\\/]/));
      const relative = path.relative(root, directory);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        throw new TypeError('Artifact directory outside root');
      await checkedDirectory(directory);
      files = await snapshotArtifacts(directory, signal);
      if (signal?.aborted) throw new Error('Run cancelled');
      result.artifactSnapshot = {
        files: files.size,
        sha256: digest(Buffer.from(JSON.stringify([...files].map(([name, file]) =>
          [name, file.sha256]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))))
      };
    } catch (error) {
      result.status = signal?.aborted ? 'cancelled' : 'failed';
      result.artifactSnapshotError = String(error.message || error).slice(0, 1024);
    }
  }
  result.finishedAt = clock.now();
  if (files && result.status === 'passed') {
    completedRuns.set(result, {plan: rebuilt, evidence: structuredClone(result), files});
  }
  return result;
}


const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function safeSegment(value) {
  return value && value !== '.' && value !== '..' &&
    !/[\\/%:\x00-\x1f\x7f"*?<>|]/.test(value) && !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function nativeAbsolute(absolute) {
  return typeof absolute === 'string' && (process.platform === 'win32'
    ? /^[A-Za-z]:[\\/]/.test(absolute)
    : absolute.startsWith('/') && !absolute.includes('\\'));
}
async function checkedDirectory(absolute) {
  if (!nativeAbsolute(absolute)) throw new TypeError('Native absolute path required');
  // Normalize separator direction before visiting every ancestor on Windows.
  absolute = path.resolve(absolute);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError('Directory link refused');
  }
  if (path.relative(absolute, await realpath(absolute)) !== '')
    throw new TypeError('Noncanonical directory refused');
  return absolute;
}

async function checkedFile(absolute, executable = false) {
  if (!nativeAbsolute(absolute)) throw new TypeError('Native absolute file required');
  await checkedDirectory(path.dirname(absolute));
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new TypeError('Regular single-link file required');
  if (path.relative(absolute, await realpath(absolute)) !== '')
    throw new TypeError('Noncanonical file refused');
  if (executable) {
    // Windows command scripts require a shell; never silently fall back to one.
    if (process.platform === 'win32' && path.extname(absolute).toLowerCase() !== '.exe')
      throw new TypeError('Windows tools require native .exe paths, not .cmd/.bat wrappers');
    await access(absolute, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  }
}
async function preflightCommand(command) {
  await checkedDirectory(command.cwd);
  await checkedFile(command.executable, true);
  if (command.tool === 'node' && command.kind === 'test') {
    for (const target of command.args.slice(1)) {
      const absolute = path.resolve(command.cwd, ...target.split(/[\\/]/));
      const relative = path.relative(command.cwd, absolute);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        throw new TypeError('Node test target outside root');
      await checkedFile(absolute);
    }
  }
}

// Immutable bounded copy eliminates request-time filesystem races. Concurrent
// filesystem mutation while taking this snapshot is not an OS sandbox boundary.
async function snapshotArtifacts(root, signal) {
  const files = new Map();
  let total = 0, entries = 0;
  async function walk(directory, prefix, depth) {
    if (depth > 16) throw new TypeError('Artifact nesting limit');
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new TypeError('Artifact directory link');
    const listing = await opendir(directory, {bufferSize: 16});
    for await (const entry of listing) {
      if (signal?.aborted) throw new Error('Serving cancelled');
      const name = entry.name;
      if (++entries > 512 || !safeSegment(name)) throw new TypeError('Artifact entry limit or unsafe name');
      const absolute = path.join(directory, name);
      const relative = prefix ? prefix + '/' + name : name;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new TypeError('Artifact symlink refused');
      if (stat.isDirectory()) { await walk(absolute, relative, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1) throw new TypeError('Artifact non-file/hardlink refused');
      const mime = MIME[path.extname(name).toLowerCase()];
      if (!mime) continue;
      if (stat.size > 8 * 1024 * 1024 || total + stat.size > 32 * 1024 * 1024)
        throw new TypeError('Artifact byte limit');
      if (path.relative(absolute, await realpath(absolute)) !== '')
        throw new TypeError('Artifact path changed');
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(stat, opened))
          throw new TypeError('Artifact changed during open');
        const data = Buffer.alloc(stat.size + 1);
        let count = 0;
        while (count < data.length) {
          const {bytesRead} = await handle.read(data, count, data.length - count, null);
          if (!bytesRead) break;
          count += bytesRead;
        }
        const after = await handle.stat();
        if (count !== stat.size || after.nlink !== 1 || !sameIdentity(opened, after))
          throw new TypeError('Artifact changed during read');
        const bytes = data.subarray(0, count);
        total += count;
        files.set(relative, {bytes, mime, sha256: digest(bytes)});
      } finally { await handle.close(); }
    }
    const after = await lstat(directory);
    if (after.isSymbolicLink() || !sameIdentity(before, after)) throw new TypeError('Artifact directory changed');
  }
  await walk(root, '', 0);
  if (!files.has('index.html')) throw new TypeError('Explicit artifact directory requires index.html');
  return files;
}

/**
 * serveArtifacts({plan,context,runResult,signal?}) -> Promise<{
 *   url, healthProof, close():Promise<void>
 * }>
 * context is independently trusted, with explicit allowServe/allowBuild.
 * runResult must be the unchanged original object from a real successful runPlan
 * in this module instance, including a build/compile and explicit serve manifest.
 * runPlan snapshots immediately after all declared steps pass; serving never
 * re-reads newer artifact bytes under an older successful run. Injection cannot mint proof.
 * Only the manifest's explicit artifact directory is served, from an immutable
 * in-memory snapshot (512 entries, depth16, 8MiB/file, 32MiB total).
 * Startup verifies a loopback GET of index.html against snapshot bytes.
 * Unsupported resource extensions are omitted; unknown paths return404. Directory
 * URLs do not list contents; only / maps to index.html. Serving never executes
 * server-side code, but served HTML/JS is trusted project content for the browser.
 * healthProof is separate from run evidence; it proves this HTTP snapshot only,
 * not browser behavior or project correctness. Closing invalidates live readiness.
 * No directory listing, filesystem writes, installation or permission changes.
 */
export async function serveArtifacts({plan, context, runResult, signal} = {}) {
  if (signal && (typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function')) throw new TypeError('Invalid signal');
  const rebuilt = createRunPlan(plan?.manifest, context);
  if (!isDeepStrictEqual(plan, rebuilt) || !rebuilt.serve || !context.allowServe)
    throw new TypeError('Explicit validated serve approval required');
  const record = completedRuns.get(runResult);
  if (!record || !isDeepStrictEqual(record.plan, rebuilt) ||
      !isDeepStrictEqual(record.evidence, runResult))
    throw new TypeError('Genuine unchanged successful build record required');
  if (signal?.aborted) throw new Error('Serving cancelled');
  // Serve the exact post-run snapshot, never newer files under an old build record.
  const files = record.files;
  if (!files) throw new TypeError('Missing post-run artifact snapshot');
  const port = rebuilt.serve.port;
  const authority = '127.0.0.1:' + port;
  const url = 'http://' + authority;
  let closed = false;
  const healthProof = {ok: false, url: url + '/index.html', sha256: files.get('index.html').sha256,
    snapshotSha256: record.evidence.artifactSnapshot.sha256,
    checkedAt: null, scope: 'immutable artifact HTTP snapshot'};
  const server = createServer({maxHeaderSize: 8192, requestTimeout: 5000,
    headersTimeout: 5000, keepAliveTimeout: 1000}, (req, res) => {
    res.setHeader('Connection', 'close');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const fail = code => { res.writeHead(code); res.end(); };
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== url))
      return fail(403);
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD'); return fail(405);
    }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] &&
        req.headers['content-length'] !== '0')) return fail(400);
    if (!req.url || req.url.length > 2048 || !req.url.startsWith('/') || req.url.startsWith('//'))
      return fail(400);
    let target;
    try {
      // Decode once, rejecting residual percent escapes and encoded separators.
      const raw = req.url.split('?')[0];
      if (/%2f|%5c/i.test(raw)) return fail(400);
      target = decodeURIComponent(raw).slice(1);
      if (!target) target = 'index.html';
      if (!target.split('/').every(safeSegment)) return fail(400);
    } catch { return fail(400); }
    const file = files.get(target);
    if (!file) return fail(404);
    res.writeHead(200, {'Content-Type': file.mime, 'Content-Length': file.bytes.length});
    res.end(req.method === 'HEAD' ? undefined : file.bytes);
  });
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(5000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('close', () => { closed = true; healthProof.ok = false; });
  server.on('error', () => { healthProof.ok = false; });
  let closing;
  const close = () => {
    if (closing) return closing;
    closed = true; healthProof.ok = false;
    signal?.removeEventListener('abort', onAbort);
    closing = new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  const onAbort = () => { void close(); };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({host: '127.0.0.1', port, exclusive: true}, () => {
        server.removeListener('error', reject); resolve();
      });
    });
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) { await close(); throw new Error('Serving cancelled'); }
    await new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      let count = 0, settled = false, request;
      const expected = files.get('index.html');
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener('abort', cancel);
        if (error) { request?.destroy(); reject(error); }
        else resolve();
      };
      const cancel = () => finish(new Error('Artifact health cancelled'));
      const deadline = setTimeout(() => finish(new Error('Artifact health timeout')), 3000);
      signal?.addEventListener('abort', cancel, {once: true});
      if (signal?.aborted) { cancel(); return; }
      try {
        request = get(url + '/index.html', {agent: false, timeout: 3000}, response => {
          response.on('error', finish);
          response.on('aborted', () => finish(new Error('Artifact health response aborted')));
          if (response.statusCode !== 200) {
            response.resume(); finish(new Error('Artifact health status failed')); return;
          }
          response.on('data', chunk => {
            if (settled) return;
            count += chunk.length;
            if (count > expected.bytes.length) finish(new Error('Health response limit'));
            else hash.update(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            if (count !== expected.bytes.length || hash.digest('hex') !== expected.sha256)
              finish(new Error('Artifact health digest failed'));
            else finish();
          });
        });
        request.on('timeout', () => finish(new Error('Artifact health timeout')));
        request.on('error', finish);
      } catch (error) { finish(error); }
    });
    if (closed) throw new Error('Serving cancelled');
    healthProof.ok = true; healthProof.checkedAt = Date.now();
    return {url, get healthProof() { return {...healthProof}; }, close};
  } catch (error) { await close(); throw error; }
}
