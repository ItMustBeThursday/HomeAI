// Argument builders and output parsers for model connectors. Pure; spawning/HTTP is a later wrapper.

export const OLLAMA_URL = 'http://127.0.0.1:11435/api/chat';

const need = (v, name) => {
  if (typeof v !== 'string' || !v) throw new Error(`${name} must be a non-empty string`);
};
const num = (v) => (Number.isFinite(v) ? v : 0);

// stdinPrompt: leave the prompt out of argv; the caller pipes it on stdin (no command-line length/quoting limits).
// stream: emit stream-json events (text deltas, tool use) instead of one JSON blob.
// streamInput: the prompt is stream-json on stdin (needed for image attachments); implies stream.
// allowedTools/permissionMode/addDirs: agent mode, where Claude may run tools in its working directory.
export function buildClaudeArgs({ prompt, model, systemPrompt, tools = [], maxTurns = 1, stdinPrompt = false, stream = false, streamInput = false, allowedTools, permissionMode, addDirs = [] } = {}) {
  if (!stdinPrompt && !streamInput) need(prompt, 'prompt');
  need(model, 'model');
  if (!Array.isArray(tools)) throw new Error('tools must be an array');
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('maxTurns must be a positive integer');
  const args = stdinPrompt || streamInput ? ['-p'] : ['-p', prompt];
  if (streamInput) args.push('--input-format', 'stream-json');
  if (stream || streamInput) args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model);
  else args.push('--output-format', 'json', '--model', model);
  if (systemPrompt !== undefined) {
    if (typeof systemPrompt !== 'string') throw new Error('systemPrompt must be a string');
    args.push('--system-prompt', systemPrompt);
  }
  args.push('--tools', tools.join(','), '--strict-mcp-config', '--no-session-persistence', '--max-turns', String(maxTurns));
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));
  if (permissionMode) args.push('--permission-mode', permissionMode);
  for (const d of addDirs) args.push('--add-dir', d);
  return args;
}

// stdin payload for streamInput: one user message holding any images, then the text.
// images: [{ mediaType, data(base64) }]
export function buildClaudeStreamInput({ prompt, images = [] }) {
  need(prompt, 'prompt');
  const content = images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }));
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

const toolSummary = (input) => String(input?.command ?? input?.file_path ?? input?.pattern ?? input?.path ?? input?.url ?? '').slice(0, 200);

// Stateful parser for `claude --output-format stream-json` lines.
// Returns events: {type:'delta', text} | {type:'tool', name, summary} | {type:'result', ...parseClaudeJson fields}
export function createClaudeStreamParser() {
  let sawText = false;
  return function parseLine(line) {
    if (!line.trim()) return [];
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return [];
    }
    if (ev === null || typeof ev !== 'object') return [];
    if (ev.type === 'result') return [{ type: 'result', ...parseClaudeJson(line) }];
    if (ev.type === 'stream_event') {
      const e = ev.event ?? {};
      if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
        // Separate text blocks (before and after tool calls) so they don't run together.
        if (sawText) return [{ type: 'delta', text: '\n\n' }];
      }
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        sawText = true;
        return [{ type: 'delta', text: e.delta.text }];
      }
      return [];
    }
    if (ev.type === 'assistant') {
      return (ev.message?.content ?? []).filter((b) => b?.type === 'tool_use').map((b) => ({ type: 'tool', name: b.name, summary: toolSummary(b.input) }));
    }
    return [];
  };
}

export function parseClaudeJson(stdout) {
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    throw new Error('Claude output is not valid JSON');
  }
  if (r === null || typeof r !== 'object') throw new Error('Claude output is not a JSON object');
  // Prompt-cache reads/writes count fully toward input: that is what subscription limits consume.
  const u = r.usage ?? {};
  return {
    text: typeof r.result === 'string' ? r.result : '',
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    outputTokens: num(r.usage?.output_tokens),
    costUsd: Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null,
    ok: r.is_error !== true,
  };
}

// images: file paths (codex reads them itself). cwd/addDirs/network are for agent mode (sandbox workspace-write).
export function buildCodexArgs({ prompt, model, sandbox = 'read-only', stdinPrompt = false, images = [], cwd, addDirs = [], network = false } = {}) {
  if (!stdinPrompt) need(prompt, 'prompt');
  need(model, 'model');
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error(`Unsupported codex sandbox "${sandbox}"`);
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check'];
  if (cwd) args.push('-C', cwd);
  for (const d of addDirs) args.push('--add-dir', d);
  if (network) args.push('-c', 'sandbox_workspace_write.network_access=true');
  for (const i of images) args.push('-i', i);
  args.push('-m', model, '-s', sandbox, stdinPrompt ? '-' : prompt);
  return args;
}

// One codex JSONL event → zero or more UI events. Codex sends whole messages, not token deltas.
export function codexEvents(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return [];
  }
  if (ev === null || typeof ev !== 'object') return [];
  const item = ev.item ?? ev.msg;
  if (!item) return [];
  if (ev.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') return [{ type: 'delta', text: item.text }];
  if (ev.type === 'item.started' && item.type === 'command_execution') return [{ type: 'tool', name: 'shell', summary: String(item.command ?? '').slice(0, 200) }];
  if (ev.type === 'item.completed' && item.type === 'file_change') {
    return [{ type: 'tool', name: 'edit', summary: (item.changes ?? []).map((c) => c.path).filter(Boolean).join(', ').slice(0, 200) }];
  }
  return [];
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

// images: base64 strings (vision models only).
// brief: a one-word classification call: no thinking, deterministic, a few tokens (about 0.1 s instead of seconds).
export function buildOllamaRequest({ model, prompt, system, images = [], brief = false } = {}) {
  need(model, 'model');
  need(prompt, 'prompt');
  const messages = [];
  if (system !== undefined && system !== '') {
    if (typeof system !== 'string') throw new Error('system must be a string');
    messages.push({ role: 'system', content: system });
  }
  messages.push(images.length ? { role: 'user', content: prompt, images } : { role: 'user', content: prompt });
  return { url: OLLAMA_URL, body: { model, stream: false, messages, ...(brief ? { think: false, options: { temperature: 0, num_predict: 8 } } : {}) } };
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
