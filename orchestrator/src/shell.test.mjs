import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShell, validateProjects, parseTestSummary } from './shell.mjs';

const NODE = process.execPath;
const win = process.platform === 'win32';

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'proj-'));
  mkdirSync(join(dir, 'sub'));
  const audit = [];
  const config = {
    default: 'p',
    projects: {
      p: { path: dir, test: [NODE, '-e', 'console.log("# tests 4");console.log("# pass 3");console.log("# fail 1");process.exit(1)'], sync: [NODE, '-e', 'console.log("synced:" + process.argv[1])', '{message}'] },
      q: { path: mkdtempSync(join(tmpdir(), 'proj-')) },
    },
  };
  return { dir, audit, shell: createShell({ config, audit: (e) => audit.push(e), ...extra }) };
}

test('validateProjects rejects bad names, relative paths, OneDrive and missing folders', () => {
  const ok = { projects: { a: { path: process.cwd() } } };
  assert.equal(validateProjects(ok), ok);
  assert.throws(() => validateProjects({}), /projects/);
  assert.throws(() => validateProjects({ projects: { 'Bad Name': { path: process.cwd() } } }), /lowercase/);
  assert.throws(() => validateProjects({ projects: { a: { path: 'relative\\dir' } } }), /absolute/);
  assert.throws(() => validateProjects({ projects: { a: { path: 'C:\\Users\\x\\OneDrive\\docs' } } }, { exists: () => true }), /OneDrive/);
  assert.throws(() => validateProjects({ projects: { a: { path: 'C:\\no\\such\\folder' } } }), /does not exist/);
  assert.throws(() => validateProjects({ projects: { a: { path: process.cwd(), test: [] } } }), /test/);
  assert.throws(() => validateProjects({ default: 'zzz', projects: { a: { path: process.cwd() } } }), /default/);
});

test('parseTestSummary reads node:test totals', () => {
  assert.deepEqual(parseTestSummary('# tests 5\n# pass 4\n# fail 1\n'), { pass: 4, fail: 1 });
  assert.deepEqual(parseTestSummary('nothing here'), { pass: null, fail: null });
});

test('projects list shows what each can do', () => {
  const { shell } = setup();
  const list = shell.projects();
  assert.equal(list.length, 2);
  assert.deepEqual(list.find((p) => p.name === 'p'), { name: 'p', path: list[0].path, description: '', canTest: true, canSync: true, git: false });
  assert.equal(shell.default, 'p');
});

test('cwd stays inside the project and never reaches OneDrive', () => {
  const { shell, dir } = setup();
  assert.equal(shell.resolveCwd({ project: 'p' }), dir);
  assert.equal(shell.resolveCwd({ project: 'p', cwd: 'sub' }), join(dir, 'sub'));
  assert.throws(() => shell.resolveCwd({ project: 'p', cwd: '..' }), /inside the project/);
  assert.throws(() => shell.resolveCwd({ project: 'p', cwd: 'C:\\Windows' }), /inside the project/);
  assert.throws(() => shell.resolveCwd({ project: 'p', cwd: 'missing' }), /does not exist/);
  assert.throws(() => shell.resolveCwd({ project: 'nope' }), /Unknown project/);
});

test('exec runs a command in the project, streams output, and audits it', { skip: !win }, async () => {
  const { shell, dir, audit } = setup();
  const chunks = [];
  const r = await shell.exec({ command: 'Write-Output "hello $((Get-Location).Path | Split-Path -Leaf)"; [Console]::Error.WriteLine("warn"); exit 3', who: 'tester', onData: (d) => chunks.push(d) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /hello proj-/);
  assert.match(r.stderr, /warn/);
  assert.equal(r.cwd, dir);
  assert.ok(chunks.some((c) => c.stream === 'stdout') && chunks.some((c) => c.stream === 'stderr'));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].who, 'tester');
  assert.equal(audit[0].code, 3);
});

test('exec refuses empty commands, OneDrive, and bad timeouts without running anything', () => {
  const { shell, audit } = setup();
  assert.throws(() => shell.exec({ command: ' ' }), /command/);
  assert.throws(() => shell.exec({ command: 'ls C:\\Users\\a\\OneDrive' }), /OneDrive/);
  assert.throws(() => shell.exec({ command: 'echo', timeoutMs: 5 }), /timeoutMs/);
  assert.equal(audit.length, 0);
});

test('exec can be cancelled and times out', { skip: !win }, async () => {
  const { shell } = setup();
  const ctrl = new AbortController();
  const started = Date.now();
  const p = shell.exec({ command: 'Start-Sleep -Seconds 60', signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 400);
  await assert.rejects(p, (e) => e.cancelled === true);
  assert.ok(Date.now() - started < 20_000);
  const t = await shell.exec({ command: 'Start-Sleep -Seconds 60', timeoutMs: 1500 });
  assert.equal(t.timedOut, true);
  assert.equal(t.ok, false);
});

test('test runs the configured command and parses the summary; projects without one are refused', async () => {
  const { shell, audit } = setup();
  const r = await shell.test('p');
  assert.equal(r.ok, false);
  assert.deepEqual([r.pass, r.fail], [3, 1]);
  assert.equal(audit[0].kind, 'test');
  await assert.rejects(shell.test('q'), /no test command/);
});

test('git: read-only views need a repository; sync substitutes the message as one argument', async () => {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => (calls.push([cmd, args]), spawn(NODE, ['-e', 'console.log("ok")'], opts));
  const { shell, dir } = setup({ gitBin: 'git-bin', spawnImpl });
  await assert.rejects(shell.git('p', 'status'), /not a git repository/);
  mkdirSync(join(dir, '.git'));
  const s = await shell.git('p', 'status');
  assert.equal(s.ok, true);
  assert.deepEqual(calls.at(-1), ['git-bin', ['status', '--short', '--branch']]);
  await assert.rejects(shell.git('p', 'push'), /Unknown git action/);
  await assert.rejects(shell.git('p', 'sync', {}), /commit message/);
  await assert.rejects(shell.git('q', 'sync', { message: 'x' }), /no sync command/);
  const nastyMessage = 'fix "quotes"; rm -rf / && echo $(whoami)';
  const sync = await shell.git('p', 'sync', { message: nastyMessage });
  assert.deepEqual(calls.at(-1)[1].at(-1), nastyMessage);
  assert.equal(sync.ok, true);
});
