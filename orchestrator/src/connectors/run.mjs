// Executes one chain entry: spawns claude/codex or calls Ollama. Prompts go over stdin, never argv.
import { spawn } from 'node:child_process';
import {
  buildClaudeArgs, parseClaudeJson, buildCodexArgs, parseCodexJsonl, buildOllamaRequest, parseOllamaResponse,
} from './cli.mjs';

// API keys in the environment would switch the CLIs from subscription auth to metered API billing.
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'];

export function collect(spawnImpl, cmd, args, { input = '', timeoutMs, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${cmd} timed out after ${timeoutMs} ms`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // child may exit before reading stdin
    child.stdin.end(input);
  });
}

const tail = (s) => s.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400);

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
} = {}) {
  const env = { ...baseEnv };
  for (const k of STRIPPED_ENV) delete env[k];

  async function viaCli(cmd, args, input, parse) {
    const { code, stdout, stderr } = await collect(spawnImpl, cmd, args, { input, timeoutMs, cwd, env });
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
  async function viaOllama(entry, prompt, system) {
    const { url, body } = buildOllamaRequest({ model: entry.model, prompt, system });
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(new Error(`Ollama gave no output within ${startTimeoutMs} ms (model busy or loading)`)), startTimeoutMs);
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
          text += ev.message?.content ?? '';
          last = ev;
        }
      }
      if (buf.trim()) {
        last = JSON.parse(buf);
        text += last.message?.content ?? '';
      }
      if (!last?.done) throw new Error('Ollama stream ended early');
      return parseOllamaResponse({ ...last, message: { content: text } });
    } catch (err) {
      throw ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason : err;
    } finally {
      clearTimeout(timer);
    }
  }

  return async function run(entry, { prompt, system }) {
    if (typeof prompt !== 'string' || !prompt) throw new Error('prompt must be a non-empty string');
    switch (entry.kind) {
      case 'claude-cli':
        return viaCli(claudeBin, buildClaudeArgs({ model: entry.model, systemPrompt: system, tools: entry.tools, maxTurns: entry.maxTurns, stdinPrompt: true }), prompt, parseClaudeJson);
      case 'codex-cli': {
        if (!codexScript) throw new Error('codexScript is not configured');
        // Codex has no system-prompt flag; prepend instructions.
        const input = system ? `${system}\n\n${prompt}` : prompt;
        return viaCli(nodeBin, [codexScript, ...buildCodexArgs({ model: entry.model, stdinPrompt: true })], input, parseCodexJsonl);
      }
      case 'ollama':
        return viaOllama(entry, prompt, system);
      default:
        throw new Error(`Unknown connector kind "${entry.kind}"`);
    }
  };
}
