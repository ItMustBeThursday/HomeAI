// Ties routing, budgets, execution and the ledger together.
import { randomUUID } from 'node:crypto';
import { validateRoutes, resolveChain } from './router.mjs';
import { makeEntry, summarize, checkBudget, capStatus, validateCaps } from './ledger.mjs';
import { buildPrompt } from './history.mjs';

const CHAT_SYSTEM = 'You are HomeAI, a helpful assistant for a family home. Answer clearly and concisely.';

export function createOrchestrator({ config, caps = {}, store, history, conversations, run, now = Date.now, newId = randomUUID }) {
  validateRoutes(config);
  validateCaps(caps, { connectors: Object.keys(config.connectors), taskTypes: Object.keys(config.routes) });
  if (typeof run !== 'function') throw new Error('run must be a function');
  const entries = store ? store.load() : [];

  function record(fields) {
    const entry = makeEntry({ ts: now(), ...fields });
    entries.push(entry);
    store?.append(entry);
    return entry;
  }

  // connector pins the request to one connector (still budget-checked); otherwise the route chain runs.
  async function task({ taskType, prompt, system, connector, source = 'api', conversationId } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must be a non-empty string');
    if (system !== undefined && typeof system !== 'string') throw new Error('system must be a string');
    if (connector !== undefined && !Object.hasOwn(config.connectors, connector)) throw new Error(`Unknown connector "${connector}"`);
    const type = typeof taskType === 'string' && taskType ? taskType : config.default;
    const route = Object.hasOwn(config.routes, type) ? type : config.default;
    let chain = resolveChain(config, route);
    if (connector) {
      const r = config.routes[route];
      chain = [{ connector, kind: config.connectors[connector].kind, model: config.connectors[connector].model, maxTurns: r.maxTurns ?? 1, tools: r.tools ?? [] }];
    }
    const id = newId();
    const begun = now();
    const attempts = [];
    let result = { ok: false, error: 'Every connector in the route failed or was over budget', taskType: route };
    for (const entry of chain) {
      const budget = checkBudget(entries, caps, entry.connector, route, now());
      if (!budget.allowed) {
        attempts.push({ connector: entry.connector, model: entry.model, skipped: budget.reason });
        continue;
      }
      const started = now();
      let out;
      try {
        out = await run(entry, { prompt, system });
      } catch (err) {
        out = { ok: false, error: err.message, inputTokens: 0, outputTokens: 0, costUsd: null };
      }
      const ms = now() - started;
      record({ connector: entry.connector, taskType: route, inputTokens: out.inputTokens ?? 0, outputTokens: out.outputTokens ?? 0, costUsd: out.costUsd ?? null, ok: !!out.ok });
      const attempt = { connector: entry.connector, model: entry.model, ok: !!out.ok, ms, inputTokens: out.inputTokens ?? 0, outputTokens: out.outputTokens ?? 0, costUsd: out.costUsd ?? null };
      if (out.ok) {
        attempts.push(attempt);
        result = { ok: true, text: out.text, connector: entry.connector, model: entry.model, taskType: route };
        break;
      }
      attempts.push({ ...attempt, error: out.error ?? 'connector reported failure' });
    }
    result = { id, ...result, attempts, ms: now() - begun };
    history?.append({ ...result, ts: begun, source, conversationId, prompt, pinned: connector });
    return result;
  }

  // Multi-turn chat: prior turns are folded into the prompt (the CLIs are stateless).
  async function chat({ conversationId, prompt, taskType, connector } = {}) {
    if (!conversations) throw new Error('Chat is not enabled');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must be a non-empty string');
    const conv = conversationId ? conversations.get(conversationId) : conversations.create({ title: prompt.trim().split('\n')[0], taskType });
    if (!conv) throw new Error('Conversation not found');
    const type = taskType || conv.taskType;
    const reply = await task({ taskType: type, prompt: buildPrompt(conv.messages, prompt), system: CHAT_SYSTEM, connector, source: 'chat', conversationId: conv.id });
    const userMsg = { role: 'user', text: prompt, ts: now() };
    const botMsg = reply.ok
      ? { role: 'assistant', text: reply.text, ts: now(), taskId: reply.id, connector: reply.connector, model: reply.model, taskType: reply.taskType, ms: reply.ms }
      : { role: 'assistant', text: '', error: reply.error, ts: now(), taskId: reply.id, taskType: reply.taskType };
    const saved = conversations.append(conv.id, userMsg, botMsg);
    return { conversation: { id: saved.id, title: saved.title }, reply };
  }

  return {
    task,
    chat,
    history,
    usage: (sinceMs) => summarize(entries, sinceMs),
    budget: (connector, taskType) => checkBudget(entries, caps, connector, taskType, now()),
    capStatus: () => capStatus(entries, caps, now()),
    // Validated before swapping, so a bad edit can't break a running service.
    setConfig(next) {
      validateRoutes(next);
      validateCaps(caps, { connectors: Object.keys(next.connectors), taskTypes: Object.keys(next.routes) });
      config = next;
    },
    setCaps(next) {
      validateCaps(next, { connectors: Object.keys(config.connectors), taskTypes: Object.keys(config.routes) });
      caps = next;
    },
    get config() {
      return config;
    },
    get caps() {
      return caps;
    },
  };
}
