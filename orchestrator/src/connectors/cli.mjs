// Argument builders and output parsers for model connectors. Pure; spawning/HTTP is a later wrapper.

export const OLLAMA_URL = 'http://127.0.0.1:11435/api/chat';

const need = (v, name) => {
  if (typeof v !== 'string' || !v) throw new Error(`${name} must be a non-empty string`);
};
const num = (v) => (Number.isFinite(v) ? v : 0);

export function buildClaudeArgs({ prompt, model, systemPrompt, tools = [], maxTurns = 1 } = {}) {
  need(prompt, 'prompt');
  need(model, 'model');
  if (!Array.isArray(tools)) throw new Error('tools must be an array');
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('maxTurns must be a positive integer');
  const args = ['-p', prompt, '--output-format', 'json', '--model', model];
  if (systemPrompt !== undefined) {
    if (typeof systemPrompt !== 'string') throw new Error('systemPrompt must be a string');
    args.push('--system-prompt', systemPrompt);
  }
  args.push('--tools', tools.join(','), '--strict-mcp-config', '--no-session-persistence', '--max-turns', String(maxTurns));
  return args;
}

export function parseClaudeJson(stdout) {
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    throw new Error('Claude output is not valid JSON');
  }
  if (r === null || typeof r !== 'object') throw new Error('Claude output is not a JSON object');
  return {
    text: typeof r.result === 'string' ? r.result : '',
    inputTokens: num(r.usage?.input_tokens),
    outputTokens: num(r.usage?.output_tokens),
    costUsd: Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null,
    ok: r.is_error !== true,
  };
}

export function buildCodexArgs({ prompt, model, sandbox = 'read-only' } = {}) {
  need(prompt, 'prompt');
  need(model, 'model');
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error(`Unsupported codex sandbox "${sandbox}"`);
  return ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-m', model, '-s', sandbox, prompt];
}

// Accepts both current ({type:"item.completed", item:{type:"agent_message", text}}) and older
// ({msg:{type:"agent_message", message}}) codex event shapes.
function agentText(ev) {
  const item = ev.item ?? ev.msg ?? ev;
  if (item?.type !== 'agent_message') return null;
  const t = item.text ?? item.message;
  return typeof t === 'string' ? t : null;
}

export function parseCodexJsonl(stdout) {
  if (typeof stdout !== 'string') throw new Error('Codex output must be a string');
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let failed = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev === null || typeof ev !== 'object') continue;
    const t = agentText(ev);
    if (t !== null) text = t;
    const usage = ev.usage ?? ev.msg?.usage ?? ev.msg?.info?.total_token_usage;
    if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
      inputTokens = num(usage.input_tokens);
      outputTokens = num(usage.output_tokens);
    }
    const type = ev.type ?? ev.msg?.type;
    if (type === 'error' || type === 'turn.failed') failed = true;
  }
  return { text, inputTokens, outputTokens, costUsd: null, ok: !failed && text !== '' };
}

export function buildOllamaRequest({ model, prompt, system } = {}) {
  need(model, 'model');
  need(prompt, 'prompt');
  const messages = [];
  if (system !== undefined && system !== '') {
    if (typeof system !== 'string') throw new Error('system must be a string');
    messages.push({ role: 'system', content: system });
  }
  messages.push({ role: 'user', content: prompt });
  return { url: OLLAMA_URL, body: { model, stream: false, messages } };
}

export function parseOllamaResponse(json) {
  if (json === null || typeof json !== 'object') throw new Error('Ollama response must be an object');
  if (typeof json.message?.content !== 'string') throw new Error('Ollama response has no message.content');
  return {
    text: json.message.content,
    inputTokens: num(json.prompt_eval_count),
    outputTokens: num(json.eval_count),
    costUsd: 0,
    ok: true,
  };
}
