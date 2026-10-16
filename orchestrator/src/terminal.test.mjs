import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { createTerminals, validateCwd } from './terminal.mjs';

const win = process.platform === 'win32';

function fakeSpawn() {
  const calls = [];
  const impl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.written = [];
    child.stdin.on('data', (d) => child.written.push(String(d)));
    child.kill = () => {}; // no pid, so killTree never reaches taskkill
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { impl, calls };
}
const tick = () => new Promise((r) => setImmediate(r));

test('validateCwd needs an absolute existing folder and refuses OneDrive', () => {
  assert.equal(validateCwd(tmpdir()), tmpdir());
  assert.throws(() => validateCwd('rel\\dir'), /absolute/);
  assert.throws(() => validateCwd(undefined), /absolute/);
  assert.throws(() => validateCwd('C:\\Users\\x\\OneDrive\\docs', { exists: () => true }), /OneDrive/);
  assert.throws(() => validateCwd('C:\\no\\such\\folder\\here'), /does not exist/);
});

test('a session starts in any folder, streams output, tracks the folder, and replays scrollback', async () => {
  const { impl, calls } = fakeSpawn();
  const audit = [];
  const t = createTerminals({ spawnImpl: impl, platform: 'win32', audit: (e) => audit.push(e), baseEnv: {} });
  const s = t.create({ cwd: tmpdir(), who: 'me' });
  assert.equal(calls[0].bin, 'powershell.exe');
  assert.equal(s.cwd, tmpdir());
  const child = calls[0].child;
  const seen = [];
  t.subscribe(s.id, 0, (ev) => seen.push(ev));
  child.stdout.write('hello\r\n\u001eCWD:C:\\Wind');
  await tick();
  child.stdout.write('ows\r\nmore\r\n');
  child.stderr.write('oops\r\n');
  await tick();
  assert.deepEqual(seen.filter((e) => e.type === 'out').map((e) => `${e.stream}:${e.text}`), ['stdout:hello\r\n', 'stdout:more\r\n', 'stderr:oops\r\n']);
  assert.equal(seen.find((e) => e.type === 'cwd').cwd, 'C:\\Windows');
  assert.equal(t.list()[0].cwd, 'C:\\Windows');
  // A second viewer picks up everything after the point it names.
  const late = [];
  t.subscribe(s.id, seen[0].seq, (ev) => late.push(ev));
  assert.equal(late.length, seen.length - 1);
  assert.equal(audit[0].kind, 'terminal-open');
  t.stop();
});

test('input: raw text goes to stdin as-is; run lines get a folder report; OneDrive is refused', () => {
  const { impl, calls } = fakeSpawn();
  const audit = [];
  const t = createTerminals({ spawnImpl: impl, platform: 'win32', audit: (e) => audit.push(e), baseEnv: {} });
  const s = t.create({ cwd: tmpdir() });
  const child = calls[0].child;
  child.written.length = 0;
  t.input(s.id, 'bob\n');
  assert.deepEqual(child.written, ['bob\n']);
  child.written.length = 0;
  t.input(s.id, 'Get-ChildItem\r\n', { run: true, who: 'adam' });
  assert.match(child.written[0], /^Get-ChildItem; Write-Output/); // one line, so prompts can't eat the report
  child.written.length = 0;
  t.input(s.id, 'ls # comment', { run: true });
  assert.match(child.written[0], /^ls # comment\nWrite-Output/); // a comment would swallow it, so separate line
  assert.ok(audit.some((e) => e.kind === 'terminal' && e.command === 'Get-ChildItem' && e.who === 'adam'));
  assert.throws(() => t.input(s.id, 'cd C:\\Users\\a\\OneDrive'), /OneDrive/);
  assert.throws(() => t.input('nope', 'x'), /not found/);
  assert.throws(() => t.input(s.id, 5), /string/);
  t.stop();
});

test('interrupt restarts the shell in the last folder; close ends the session; session count is capped', async () => {
  const { impl, calls } = fakeSpawn();
  const t = createTerminals({ spawnImpl: impl, platform: 'win32', maxSessions: 2, baseEnv: {} });
  const a = t.create({ cwd: tmpdir() });
  calls[0].child.stdout.write('\u001eCWD:C:\\Windows\r\n');
  await tick();
  t.interrupt(a.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.cwd, 'C:\\Windows');
  t.create({ cwd: tmpdir() });
  assert.throws(() => t.create({ cwd: tmpdir() }), /At most 2/);
  const ev = [];
  t.subscribe(a.id, 0, (e) => ev.push(e));
  t.close(a.id);
  assert.ok(ev.some((e) => e.type === 'exit' && e.closed));
  assert.equal(t.list().length, 1);
  assert.throws(() => t.input(a.id, 'x'), /not found/);
  t.stop();
});

test('unknown shells are refused', () => {
  const t = createTerminals({ spawnImpl: fakeSpawn().impl, platform: 'win32', baseEnv: {} });
  assert.throws(() => t.create({ cwd: tmpdir(), shell: 'fish' }), /Unknown shell/);
  t.stop();
});

test('real PowerShell keeps state between commands and reads input typed later', { skip: !win, timeout: 30_000 }, async (ctx) => {
  const t = createTerminals({ baseEnv: process.env });
  const s = t.create({ cwd: tmpdir() });
  ctx.after(() => t.stop()); // also on failure, so a stuck shell can't keep the test run alive
  let text = '';
  let cwd = '';
  t.subscribe(s.id, 0, (ev) => { if (ev.type === 'out') text += ev.text; if (ev.type === 'cwd') cwd = ev.cwd; });
  const until = async (re) => { for (let i = 0; i < 150 && !re.test(text); i++) await new Promise((r) => setTimeout(r, 100)); };
  t.input(s.id, '$x = 41 + 1', { run: true });
  t.input(s.id, 'Write-Output "x is $x"', { run: true });
  await until(/x is 42/);
  assert.match(text, /x is 42/);
  t.input(s.id, '$n = Read-Host "name"', { run: true });
  await new Promise((r) => setTimeout(r, 400));
  t.input(s.id, 'bob\n');
  t.input(s.id, 'Write-Output "hi $n"', { run: true });
  await until(/hi bob/);
  assert.match(text, /hi bob/);
  t.input(s.id, 'cd $env:windir', { run: true });
  for (let i = 0; i < 50 && !/windows/i.test(cwd); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(cwd, /windows/i);
  assert.ok(!text.includes('\u001e'), 'folder reports are not shown as output');
  t.stop();
});
