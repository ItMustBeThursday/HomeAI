// Executes one chain entry: spawns claude/codex or calls Ollama. Prompts go over stdin, never argv.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  buildClaudeArgs, buildClaudeStreamInput, createClaudeStreamParser, parseClaudeJson,
  buildCodexArgs, parseCodexJsonl, codexEvents, buildOllamaRequest, parseOllamaResponse,
} from './cli.mjs';

// API keys in the environment would switch the CLIs from subscription auth to metered API billing.
export const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'];

export const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

// Kills the child and everything it started (codex/claude spawn helpers; plain kill() leaves them running on Windows).
export function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      return;
    } catch {}
  }
  child.kill();
}

// onLine(line) sees each complete stdout line as it arrives; signal aborts (and kills) the child.
export function collect(spawnImpl, cmd, args, { input = '', timeoutMs, cwd, env, onLine, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const child = spawnImpl(cmd, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
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
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d;
      if (!onLine) return;
      pending += d;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const l of lines) onLine(l.replace(/\r$/, ''));
    });
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      done();
      reject(new Error(`Failed to start ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      done();
      if (pending && onLine) onLine(pending.replace(/\r$/, ''));
      if (aborted) reject(cancelled());
      else if (timedOut) reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // child may exit before reading stdin
    child.stdin.end(input);
  });
}

const tail = (s) => s.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400);
const AGENT_TIMEOUT_MS = 1_800_000;

export function createRunner({
  claudeBin = 'claude',
  codexScript,
  nodeBin = process.execPath,
  ollamaUrl,
  cwd,
  timeoutMs = 300_000,
  startTimeoutMs = 60_000,
  spawnImpl = spawn,
  fetchImpl = fetch,
  baseEnv = process.env,
  readFile = readFileSync,
  comfyRun,
} = {}) {
  const env = { ...baseEnv };
  for (const k of STRIPPED_ENV) delete env[k];

  async function viaCli(cmd, args, input, parse, { signal, runCwd, limit, onLine } = {}) {
    const { code, stdout, stderr } = await collect(spawnImpl, cmd, args, { input, timeoutMs: limit ?? timeoutMs, cwd: runCwd ?? cwd, env, signal, onLine });
    let parsed;
    try {
      parsed = parse(stdout);
    } catch (err) {
      throw new Error(`${err.message} (exit ${code}): ${tail(stderr || stdout)}`);
    }
    if (!parsed.ok && !parsed.error) parsed.error = tail(parsed.text || stderr || stdout) || `exit ${code}`;
    return parsed;
  }

  // Streams so a request queued behind another model (single-GPU Ollama) fails over after
  // startTimeoutMs instead of blocking the whole chain; once tokens flow, timeoutMs applies.
  async function viaOllama(entry, prompt, system, { images = [], signal, emit }) {
    const { url, body } = buildOllamaRequest({ model: entry.model, prompt, system, images, brief: !!entry.brief });
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(new Error(`Ollama gave no output within ${startTimeoutMs} ms (model busy or loading)`)), startTimeoutMs);
    const onAbort = () => ctrl.abort(cancelled());
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetchImpl(ollamaUrl ?? url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(`Ollama HTTP ${res.status}: ${err?.error ?? 'request failed'}`);
      }
      let text = '';
      let last = null;
      let buf = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        if (!last) {
          clearTimeout(timer);
          timer = setTimeout(() => ctrl.abort(new Error(`Ollama timed out after ${timeoutMs} ms`)), timeoutMs);
        }
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.error) throw new Error(`Ollama: ${ev.error}`);
          const piece = ev.message?.content ?? '';
          text += piece;
          if (piece) emit({ type: 'delta', text: piece });
          last = ev;
        }
      }
      if (buf.trim()) {
        last = JSON.parse(buf);
        const piece = last.message?.content ?? '';
        text += piece;
        if (piece) emit({ type: 'delta', text: piece });
      }
      if (!last?.done) throw new Error('Ollama stream ended early');
      return parseOllamaResponse({ ...last, message: { content: text } });
    } catch (err) {
      throw ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason : err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // images: [{path, mediaType}] already stored on disk by the caller.
  // entry.agent: let the model use tools (shell, files) inside opts.cwd; otherwise it is a plain text call.
  return async function run(entry, { prompt, system, images = [], cwd: workDir, addDirs = [], signal, onDelta, onEvent } = {}) {
    if (typeof prompt !== 'string' || !prompt) throw new Error('prompt must be a non-empty string');
    const emit = (ev) => {
      onEvent?.(ev);
      if (ev.type === 'delta') onDelta?.(ev.text);
    };
    const streaming = !!(onDelta || onEvent || entry.agent);
    const agent = !!entry.agent;
    // readOnly (planning): may look around the project but not change it.
    const canWrite = agent && !entry.readOnly;
    if (agent && !workDir) throw new Error('Agent routes need a project (working directory)');
    switch (entry.kind) {
      case 'claude-cli': {
        const withImages = images.length > 0;
        const args = buildClaudeArgs({
          model: entry.model, systemPrompt: system, tools: entry.tools, maxTurns: entry.maxTurns, stdinPrompt: true,
          stream: streaming, streamInput: withImages,
          allowedTools: agent ? entry.tools : undefined, permissionMode: canWrite ? 'acceptEdits' : undefined, addDirs: agent ? addDirs : [],
        });
        const input = withImages
          ? buildClaudeStreamInput({ prompt, images: images.map((i) => ({ mediaType: i.mediaType, data: readFile(i.path).toString('base64') })) })
          : prompt;
        const limit = agent ? AGENT_TIMEOUT_MS : undefined;
        if (!streaming && !withImages) return viaCli(claudeBin, args, input, parseClaudeJson, { signal, limit });
        const parse = createClaudeStreamParser();
        let result = null;
        const onLine = (line) => {
          for (const ev of parse(line)) {
            if (ev.type === 'result') result = ev;
            else emit(ev);
          }
        };
        const { code, stderr, stdout } = await collect(spawnImpl, claudeBin, args, { input, timeoutMs: limit ?? timeoutMs, cwd: agent ? workDir : cwd, env, signal, onLine });
        if (!result) throw new Error(`Claude produced no result (exit ${code}): ${tail(stderr || stdout)}`);
        const { type, ...out } = result;
        if (!out.ok && !out.error) out.error = tail(out.text || stderr) || `exit ${code}`;
        return out;
      }
      case 'codex-cli': {
        if (!codexScript) throw new Error('codexScript is not configured');
        // Codex has no system-prompt flag; prepend instructions.
        const input = system ? `${system}\n\n${prompt}` : prompt;
        const args = [codexScript, ...buildCodexArgs({
          model: entry.model, stdinPrompt: true, images: images.map((i) => i.path),
          sandbox: canWrite ? 'danger-full-access' : 'read-only', cwd: agent ? workDir : undefined, addDirs: agent ? addDirs : [], network: canWrite,
        })];
        const onLine = streaming ? (line) => codexEvents(line).forEach(emit) : undefined;
        return viaCli(nodeBin, args, input, parseCodexJsonl, { signal, runCwd: agent ? workDir : undefined, limit: agent ? AGENT_TIMEOUT_MS : undefined, onLine });
      }
      case 'ollama': {
        if (images.length && !entry.vision) throw new Error(`Connector ${entry.model} cannot read images`);
        return viaOllama(entry, prompt, system, { images: images.map((i) => readFile(i.path).toString('base64')), signal, emit });
      }
      case 'comfyui': {
        if (!comfyRun) throw new Error('ComfyUI is not configured');
        if (agent) throw new Error('Media connectors cannot run agent routes');
        return comfyRun(entry, { prompt, signal });
      }
      default:
        throw new Error(`Unknown connector kind "${entry.kind}"`);
    }
  };
}
