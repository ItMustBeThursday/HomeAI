// Live check that the parsers match real connector output. Usage: node scripts/smoke.mjs [ollama] [claude] [codex]
import { execFileSync } from 'node:child_process';
import {
  buildClaudeArgs, parseClaudeJson, buildCodexArgs, parseCodexJsonl, buildOllamaRequest, parseOllamaResponse,
} from '../src/connectors/cli.mjs';

const CODEX = 'D:\\HomeAI\\state\\openclaw\\npm\\projects\\openclaw-codex-8902d781d4\\node_modules\\.bin\\codex.cmd';
const PROMPT = 'Reply with exactly: pong';
const which = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['ollama']);

async function ollama() {
  const { url, body } = buildOllamaRequest({ model: 'homeai-fast:locked', prompt: PROMPT });
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  return parseOllamaResponse(await res.json());
}

function claude() {
  // Windows drops empty argv entries for .cmd shims; claude.exe/native binary keeps them.
  const out = execFileSync('claude', buildClaudeArgs({ prompt: PROMPT, model: 'haiku' }), { encoding: 'utf8', input: '' });
  return parseClaudeJson(out);
}

function codex() {
  const out = execFileSync(CODEX, buildCodexArgs({ prompt: PROMPT, model: 'gpt-5-mini' }), { encoding: 'utf8', shell: true, input: '' });
  return parseCodexJsonl(out);
}

for (const [name, fn] of Object.entries({ ollama, claude, codex })) {
  if (!which.has(name)) continue;
  try {
    console.log(name, JSON.stringify(await fn()));
  } catch (err) {
    console.log(name, 'FAILED', err.message.split('\n')[0]);
  }
}
