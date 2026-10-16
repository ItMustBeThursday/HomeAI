// Persistent interactive shells for the WebUI Terminal. Each session is one long-lived shell process: state (cd,
// variables, env) survives between commands, input is streamed to its stdin (so Read-Host, REPLs and prompts work),
// and output streams back live. Output is kept as a scrollback so a closed tab can reattach.
//
// Not a PTY (zero dependencies): full-screen programs (vim, htop) won't render. Everything runs as the user who
// started the service, so callers must be admin (enforced in the server). Unlike /api/exec in a project, a session
// may start in any folder. The one standing exclusion is OneDrive (cwd and command text are refused).
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { killTree, STRIPPED_ENV } from './connectors/run.mjs';

const ONEDRIVE = /onedrive/i;
const MAX_BUFFER = 400_000; // characters of scrollback kept per session
const MAX_INPUT = 200_000;
const IDLE_MS = 12 * 3_600_000;
const MARK = '\u001e'; // record separator: precedes the working-directory report our wrapper prints after each input

const SHELLS = {
  powershell: { win: ['powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-']], init: '[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::InputEncoding=[Text.Encoding]::UTF8', report: `Write-Output ([string][char]30+'CWD:'+(Get-Location).Path)` },
  pwsh: { win: ['pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', '-']], init: '[Console]::OutputEncoding=[Text.Encoding]::UTF8', report: `Write-Output ([string][char]30+'CWD:'+(Get-Location).Path)` },
  cmd: { win: ['cmd.exe', ['/Q', '/K', 'chcp 65001 >nul']], init: null, sep: ' & ', report: `echo ${MARK}CWD:%CD%` },
  sh: { win: null, posix: ['sh', []], init: null, report: `printf '\\036CWD:%s\\n' "$PWD"` },
};

export function validateCwd(cwd, { exists = existsSync, isDir = (p) => statSync(p).isDirectory() } = {}) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('cwd must be an absolute folder path');
  const dir = resolve(cwd);
  if (ONEDRIVE.test(dir)) throw new Error('OneDrive is off limits');
  if (!exists(dir) || !isDir(dir)) throw new Error(`Folder does not exist: ${dir}`);
  return dir;
}

export function createTerminals({ spawnImpl = spawn, audit, now = Date.now, baseEnv = process.env, platform = process.platform, defaultCwd, maxSessions = 8, newId = randomUUID } = {}) {
  const env = { ...baseEnv };
  for (const k of STRIPPED_ENV) delete env[k];
  const sessions = new Map();

  const shellFor = (name) => {
    const key = name ?? (platform === 'win32' ? 'powershell' : 'sh');
    const def = SHELLS[key];
    if (!def) throw new Error(`Unknown shell "${key}" (${Object.keys(SHELLS).join(', ')})`);
    const cmd = platform === 'win32' ? def.win : def.posix ?? ['sh', []];
    if (!cmd) throw new Error(`Shell "${key}" is not available on this system`);
    return { key, def, cmd };
  };

  function emit(s, ev) {
    ev.seq = ++s.seq;
    s.buffer.push(ev);
    s.bufChars += ev.text?.length ?? 0;
    while (s.bufChars > MAX_BUFFER && s.buffer.length > 1) s.bufChars -= s.buffer.shift().text?.length ?? 0;
    for (const fn of s.subs) fn(ev);
  }

  // Output arrives in arbitrary chunks, so the CWD report (MARK + "CWD:" + path + newline) can be split. Hold back a
  // trailing partial marker line until it is complete.
  function onStdout(s, chunk) {
    s.pending += chunk;
    let out = '';
    for (;;) {
      const at = s.pending.indexOf(MARK);
      if (at < 0) {
        out += s.pending;
        s.pending = '';
        break;
      }
      out += s.pending.slice(0, at);
      const nl = s.pending.indexOf('\n', at);
      if (nl < 0) {
        s.pending = s.pending.slice(at); // wait for the rest of the line
        break;
      }
      const line = s.pending.slice(at + 1, nl).replace(/\r$/, '');
      s.pending = s.pending.slice(nl + 1);
      if (line.startsWith('CWD:')) {
        s.cwd = line.slice(4);
        emit(s, { type: 'cwd', text: '', cwd: s.cwd });
      }
    }
    if (out) emit(s, { type: 'out', stream: 'stdout', text: out });
  }

  function start(s) {
    const { cmd: [bin, args], def } = shellFor(s.shell);
    const child = spawnImpl(bin, args, { cwd: s.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    s.child = child;
    s.pending = '';
    s.exited = false;
    child.stdout.setEncoding('utf8').on('data', (d) => onStdout(s, d));
    child.stderr.setEncoding('utf8').on('data', (d) => emit(s, { type: 'out', stream: 'stderr', text: d }));
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      s.exited = true;
      emit(s, { type: 'exit', text: '', code: null, error: `Failed to start ${bin}: ${err.message}` });
    });
    child.on('close', (code) => {
      if (s.child !== child) return; // replaced by a restart
      s.exited = true;
      emit(s, { type: 'exit', text: '', code });
    });
    if (def.init) child.stdin.write(`${def.init}\n`);
    child.stdin.write(`${def.report}\n`);
  }

  const view = (s) => ({ id: s.id, shell: s.shell, cwd: s.cwd, startedAt: s.startedAt, lastActive: s.lastActive, exited: s.exited, who: s.who, seq: s.seq });
  const get = (id) => {
    const s = sessions.get(id);
    if (!s) throw new Error('Terminal session not found');
    return s;
  };

  const reaper = setInterval(() => {
    for (const s of sessions.values()) if (now() - s.lastActive > IDLE_MS) api.close(s.id);
  }, 300_000);
  reaper.unref();

  const api = {
    list: () => [...sessions.values()].map(view),
    create({ cwd, shell: shellName, who = 'api' } = {}) {
      if (sessions.size >= maxSessions) throw new Error(`At most ${maxSessions} terminals at once; close one first`);
      const dir = validateCwd(cwd ?? defaultCwd);
      const { key } = shellFor(shellName);
      const s = { id: newId(), shell: key, cwd: dir, who, startedAt: now(), lastActive: now(), seq: 0, buffer: [], bufChars: 0, subs: new Set(), pending: '', exited: false, child: null };
      sessions.set(s.id, s);
      start(s);
      audit?.({ ts: now(), who, kind: 'terminal-open', cwd: dir, command: key });
      return view(s);
    },
    // Replays scrollback after `since`, then streams live. Returns an unsubscribe function.
    subscribe(id, since, fn) {
      const s = get(id);
      for (const ev of s.buffer) if (ev.seq > since) fn(ev);
      s.subs.add(fn);
      return () => s.subs.delete(fn);
    },
    // Sends text to the shell's stdin exactly as given. With `run`, the text is a command line: a newline and a
    // working-directory report are appended so the prompt stays current.
    input(id, data, { run = false, who = 'api' } = {}) {
      const s = get(id);
      if (typeof data !== 'string') throw new Error('data must be a string');
      if (data.length > MAX_INPUT) throw new Error('Input too large');
      if (ONEDRIVE.test(data)) throw new Error('Input that mentions OneDrive is refused');
      if (s.exited) throw new Error('This shell has exited; restart it');
      s.lastActive = now();
      if (run) {
        const { def } = shellFor(s.shell);
        const line = data.replace(/\r?\n$/, '');
        audit?.({ ts: now(), who, kind: 'terminal', cwd: s.cwd, command: line.slice(0, 500) });
        // On the same line when it is safe, so a program waiting for input (Read-Host, a REPL) cannot swallow the
        // report as its answer. Multi-line input and comments need the report on its own line.
        const together = !/[\r\n#]/.test(line) && !/[{(`,|&]$/.test(line.trim());
        s.child.stdin.write(together ? `${line}${def.sep ?? '; '}${def.report}\n` : `${line}\n${def.report}\n`);
      } else s.child.stdin.write(data);
      return { ok: true };
    },
    // Ctrl+C equivalent: ends the running shell tree and starts a fresh one in the last known folder.
    interrupt(id, { who = 'api' } = {}) {
      const s = get(id);
      const old = s.child;
      audit?.({ ts: now(), who, kind: 'terminal-interrupt', cwd: s.cwd });
      emit(s, { type: 'notice', text: '^C — shell restarted (variables from the old session are gone)\n' });
      killTree(old);
      s.child = null;
      start(s);
      return view(s);
    },
    close(id, { who = 'api' } = {}) {
      const s = get(id);
      sessions.delete(id);
      const child = s.child;
      s.child = null;
      if (child) killTree(child);
      emit(s, { type: 'exit', text: '', code: null, closed: true });
      s.subs.clear();
      audit?.({ ts: now(), who, kind: 'terminal-close', cwd: s.cwd });
      return { ok: true };
    },
    closeAll() {
      for (const id of [...sessions.keys()]) api.close(id);
    },
    stop() {
      clearInterval(reaper);
      api.closeAll();
    },
  };
  return api;
}
