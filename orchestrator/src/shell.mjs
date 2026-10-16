// Shell, test and git access for registered projects. Everything runs as the user who started the service,
// so callers must be admin (enforced in the server). cwd is limited to registered project folders, every run is
// audited, and anything touching OneDrive is refused (standing rule).
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve, relative } from 'node:path';
import { killTree, cancelled, STRIPPED_ENV } from './connectors/run.mjs';
import { validateCwd } from './terminal.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const argv = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s);
const ONEDRIVE = /onedrive/i;
const MAX_OUTPUT = 1_000_000;

export function validateProjects(cfg, { exists = existsSync } = {}) {
  if (!isObj(cfg) || !isObj(cfg.projects) || !Object.keys(cfg.projects).length) throw new Error('projects config needs a non-empty "projects" object');
  for (const [name, p] of Object.entries(cfg.projects)) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error(`Project name "${name}" must be lowercase letters, digits and dashes`);
    if (!isObj(p)) throw new Error(`Project "${name}" must be an object`);
    if (typeof p.path !== 'string' || !isAbsolute(p.path)) throw new Error(`Project "${name}" needs an absolute path`);
    if (ONEDRIVE.test(p.path)) throw new Error(`Project "${name}" is under OneDrive, which is off limits`);
    if (!exists(p.path)) throw new Error(`Project "${name}" path does not exist: ${p.path}`);
    if (p.test !== undefined && !argv(p.test)) throw new Error(`Project "${name}" test must be a non-empty array of strings`);
    if (p.sync !== undefined && !argv(p.sync)) throw new Error(`Project "${name}" sync must be a non-empty array of strings`);
  }
  if (cfg.default !== undefined && !Object.hasOwn(cfg.projects, cfg.default)) throw new Error('default must name a project');
  return cfg;
}

// node:test summary lines ("# pass 77") → { pass, fail }
export function parseTestSummary(output) {
  const grab = (k) => {
    const m = [...output.matchAll(new RegExp(`^# ${k} (\\d+)`, 'gm'))].pop();
    return m ? Number(m[1]) : null;
  };
  return { pass: grab('pass'), fail: grab('fail') };
}

const inside = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export function createShell({ config, gitBin = 'git', spawnImpl = spawn, audit, now = Date.now, baseEnv = process.env, platform = process.platform } = {}) {
  validateProjects(config);
  const env = { ...baseEnv };
  for (const k of STRIPPED_ENV) delete env[k];

  const project = (name) => {
    const p = config.projects[name ?? config.default];
    if (!p) throw new Error(`Unknown project "${name}"`);
    return { name: name ?? config.default, ...p };
  };

  function resolveCwd({ project: name, cwd } = {}) {
    const p = project(name);
    if (cwd === undefined || cwd === '') return resolve(p.path);
    const target = resolve(p.path, cwd);
    if (!inside(resolve(p.path), target)) throw new Error('cwd must be inside the project folder');
    if (ONEDRIVE.test(target)) throw new Error('OneDrive is off limits');
    if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`cwd does not exist: ${target}`);
    return target;
  }

  // Runs argv (no shell) with streaming output. Resolves with the result; never throws on a non-zero exit.
  function spawnCapture(cmd, args, { cwd, timeoutMs, signal, onData, input }) {
    return new Promise((resolveRun, reject) => {
      if (signal?.aborted) return reject(cancelled());
      const started = now();
      const child = spawnImpl(cmd, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const out = { stdout: '', stderr: '' };
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
      const onAbort = () => {
        aborted = true;
        killTree(child);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const feed = (stream) => (d) => {
        onData?.({ stream, text: d });
        if (out[stream].length + d.length > MAX_OUTPUT) {
          truncated = true;
          out[stream] += d.slice(0, Math.max(0, MAX_OUTPUT - out[stream].length));
        } else out[stream] += d;
      };
      child.stdout.setEncoding('utf8').on('data', feed('stdout'));
      child.stderr.setEncoding('utf8').on('data', feed('stderr'));
      child.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Failed to start ${cmd}: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (aborted) return reject(cancelled());
        resolveRun({ ok: code === 0 && !timedOut, code, timedOut, truncated, ms: now() - started, ...out });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    });
  }

  const audited = async (kind, who, cwd, label, fn) => {
    try {
      const r = await fn();
      audit?.({ ts: now(), who, kind, cwd, command: label, code: r.code, ms: r.ms });
      return r;
    } catch (err) {
      audit?.({ ts: now(), who, kind, cwd, command: label, error: err.message });
      throw err;
    }
  };

  return {
    projects: () => Object.entries(config.projects).map(([name, p]) => ({ name, path: p.path, description: p.description ?? '', canTest: !!p.test, canSync: !!p.sync, git: existsSync(resolve(p.path, '.git')) })),
    project,
    resolveCwd,
    get default() {
      return config.default;
    },

    // command: a PowerShell (Windows) or sh script. Encoded so quoting can't change its meaning.
    exec({ command, project: name, cwd, timeoutMs = 120_000, signal, onData, who = 'api' } = {}) {
      if (typeof command !== 'string' || !command.trim()) throw new Error('command must be a non-empty string');
      if (ONEDRIVE.test(command)) throw new Error('Commands that mention OneDrive are refused');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) throw new Error('timeoutMs must be 1000-1800000');
      // An absolute cwd may point anywhere (admin only); a relative one stays inside the project.
      const dir = typeof cwd === 'string' && isAbsolute(cwd) ? validateCwd(cwd) : resolveCwd({ project: name, cwd });
      const [cmd, args] = platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]]
        : ['sh', ['-c', command]];
      return audited('exec', who, dir, command.slice(0, 500), async () => ({ cwd: dir, ...(await spawnCapture(cmd, args, { cwd: dir, timeoutMs, signal, onData })) }));
    },

    // Runs the project's configured test command.
    async test(name, { signal, onData, who = 'api' } = {}) {
      const p = project(name);
      if (!p.test) throw new Error(`Project "${p.name}" has no test command`);
      const dir = resolveCwd({ project: p.name });
      const [cmd, ...args] = p.test;
      const r = await audited('test', who, dir, p.test.join(' '), () => spawnCapture(cmd, args, { cwd: dir, timeoutMs: 900_000, signal, onData }));
      return { project: p.name, ...r, ...parseTestSummary(r.stdout + r.stderr) };
    },

    // Read-only git views plus the project's publish command.
    async git(name, action, { message, signal, onData, who = 'api' } = {}) {
      const p = project(name);
      const dir = resolveCwd({ project: p.name });
      const views = {
        status: ['status', '--short', '--branch'],
        log: ['log', '--oneline', '-n', '20'],
        diff: ['diff', '--stat'],
        remote: ['remote', '-v'],
      };
      if (action === 'sync') {
        if (!p.sync) throw new Error(`Project "${p.name}" has no sync command`);
        if (typeof message !== 'string' || !message.trim()) throw new Error('A commit message is required to sync');
        const [cmd, ...args] = p.sync.map((a) => a.replaceAll('{message}', message.trim()));
        return audited('git-sync', who, dir, `${p.sync.join(' ')} :: ${message.trim().slice(0, 100)}`, () => spawnCapture(cmd, args, { cwd: dir, timeoutMs: 600_000, signal, onData }));
      }
      if (!Object.hasOwn(views, action)) throw new Error(`Unknown git action "${action}" (status, log, diff, remote, sync)`);
      if (!existsSync(resolve(p.path, '.git'))) throw new Error(`Project "${p.name}" is not a git repository`);
      return audited('git', who, dir, `git ${views[action].join(' ')}`, () => spawnCapture(gitBin, views[action], { cwd: dir, timeoutMs: 60_000, signal, onData }));
    },
  };
}
