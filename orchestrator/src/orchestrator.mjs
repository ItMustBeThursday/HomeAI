// Ties routing, budgets, execution and the ledger together.
import { randomUUID } from 'node:crypto';
import { validateRoutes, resolveChain } from './router.mjs';
import { makeEntry, summarize, checkBudget, capStatus, validateCaps } from './ledger.mjs';
import { buildPrompt } from './history.mjs';

const CHAT_SYSTEM = 'You are HomeAI, a helpful assistant for a family home. Answer clearly and concisely.';
const AGENT_SYSTEM = [
  'You are HomeAI working as a coding and operations agent inside one project directory.',
  'You may run shell commands, read and edit files, run tests and use git. Make the change, run the relevant tests, and report what you did and the results.',
  'Rules: never touch anything under OneDrive; never print or commit secrets; do not delete files without a restorable backup; do not push or publish unless the user asked for it.',
].join(' ');
const PLAN_SYSTEM = [
  'You are HomeAI planning a change inside one project directory. You can only look: list, search and read files. Change nothing.',
  'Inspect what is actually there, then reply with: 1) a short summary of the current layout that matters; 2) a numbered plan of exact operations (create/move/rename/edit/delete, with full relative paths);',
  '3) references that must be updated so nothing breaks (imports, configs, scripts, docs, registered project paths, scheduled tasks); 4) risks, including anything that moves a running service or a folder registered in config/projects.json;',
  '5) how each deletion is backed up; 6) how to verify the result. Keep it tight. End by asking the user to approve or change the plan.',
  'Rules: never touch anything under OneDrive.',
].join(' ');
const APPROVED = 'The user approved the plan below. Carry it out step by step. If what you find differs from what the plan expected, stop and report instead of improvising. Finish with what you did, what you verified, and anything left undone.';

export function createOrchestrator({ config, caps = {}, store, history, conversations, memory, run, limiter, now = Date.now, newId = randomUUID }) {
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

  function routeFor(taskType, hasImages) {
    let type = typeof taskType === 'string' && taskType ? taskType : null;
    // A picture with no route chosen goes to the vision route when there is one.
    if (!type && hasImages && Object.hasOwn(config.routes, 'vision')) type = 'vision';
    type ??= config.default;
    return Object.hasOwn(config.routes, type) ? type : config.default;
  }

  const isAgentRoute = (taskType) => !!config.routes[routeFor(taskType, false)]?.agent;

  // The plan waiting for approval and the route that carries it out, or null. A plan is pending when it is the
  // last message, or only failed/stopped approval attempts follow it (so a failed run can be retried).
  function pendingPlan(conv) {
    const msgs = conv?.messages ?? [];
    let i = msgs.length - 1;
    while (i >= 2 && msgs[i].role === 'assistant' && msgs[i].error && msgs[i - 1].approved) i -= 2;
    const last = msgs[i];
    if (last?.role !== 'assistant' || !last.plan || !last.text) return null;
    const then = config.routes[last.taskType]?.then;
    return then ? { text: last.text, route: then, project: last.project } : null;
  }

  // connector pins the request to one connector (still budget-checked); otherwise the route chain runs.
  // images: attachments already stored on disk. cwd: project directory (agent routes only).
  // onEvent receives {type:'attempt'|'delta'|'tool'|'attempt-failed', ...} while the model works; signal cancels.
  async function task({ taskType, prompt, system, connector, source = 'api', conversationId, images = [], cwd, signal, onEvent } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must be a non-empty string');
    if (system !== undefined && typeof system !== 'string') throw new Error('system must be a string');
    if (connector !== undefined && !Object.hasOwn(config.connectors, connector)) throw new Error(`Unknown connector "${connector}"`);
    const route = routeFor(taskType, images.length > 0);
    const r = config.routes[route];
    if (r.agent && !cwd) throw new Error(`Route "${route}" runs commands, so it needs a project`);
    if (!r.agent && cwd) throw new Error(`Route "${route}" is not an agent route; a project can only be used with one`);
    let chain = resolveChain(config, route);
    if (connector) {
      const c = config.connectors[connector];
      chain = [{ connector, kind: c.kind, model: c.model, maxTurns: r.maxTurns ?? 1, tools: r.tools ?? [], ...(c.vision ? { vision: true } : {}), ...(r.agent ? { agent: true } : {}), ...(r.readOnly ? { readOnly: true } : {}) }];
    }
    let sys = system;
    if (r.agent) sys = [r.readOnly ? PLAN_SYSTEM : AGENT_SYSTEM, sys].filter(Boolean).join('\n\n');
    if (r.memory && memory) {
      const mem = memory.context(prompt, { tags: Array.isArray(r.memory) ? r.memory : undefined });
      if (mem) sys = [sys, mem].filter(Boolean).join('\n\n');
    }
    const id = newId();
    const begun = now();
    const attempts = [];
    let result = { ok: false, error: 'Every connector in the route failed or was over budget', taskType: route };
    for (const entry of chain) {
      if (signal?.aborted) {
        result = { ok: false, error: 'Cancelled', cancelled: true, taskType: route };
        break;
      }
      const budget = checkBudget(entries, caps, entry.connector, route, now());
      if (!budget.allowed) {
        attempts.push({ connector: entry.connector, model: entry.model, skipped: budget.reason });
        continue;
      }
      if (images.length && entry.kind === 'ollama' && !entry.vision) {
        attempts.push({ connector: entry.connector, model: entry.model, skipped: 'cannot read images' });
        continue;
      }
      const started = now();
      onEvent?.({ type: 'attempt', connector: entry.connector, model: entry.model });
      const emit = (ev) => onEvent?.({ ...ev, connector: entry.connector });
      const call = () => {
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        return run(entry, { prompt, system: sys, images, cwd, signal, onEvent: onEvent ? emit : undefined });
      };
      let out;
      try {
        out = await (limiter ? limiter.run(entry.kind, call) : call());
      } catch (err) {
        out = { ok: false, error: err.message, cancelled: !!err.cancelled, inputTokens: 0, outputTokens: 0, costUsd: null };
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
      onEvent?.({ type: 'attempt-failed', connector: entry.connector, error: out.error ?? 'connector reported failure' });
      if (out.cancelled) {
        result = { ok: false, error: 'Cancelled', cancelled: true, taskType: route };
        break;
      }
    }
    result = { id, ...result, attempts, ms: now() - begun };
    history?.append({ ...result, ts: begun, source, conversationId, prompt, pinned: connector, images: images.length || undefined, project: cwd });
    return result;
  }

  // Multi-turn chat: prior turns are folded into the prompt (the CLIs are stateless).
  // approve: carry out the plan that ends the conversation, on the planning route's `then` route (prompt optional;
  // it is added as extra instructions). The caller resolves cwd for that route (see approvalFor).
  async function chat({ conversationId, prompt, taskType, connector, images = [], cwd, project, approve = false, signal, onEvent } = {}) {
    if (!conversations) throw new Error('Chat is not enabled');
    let conv;
    let type;
    let modelPrompt;
    if (approve) {
      conv = conversationId ? conversations.get(conversationId) : null;
      if (!conv) throw new Error('Conversation not found');
      const plan = pendingPlan(conv);
      if (!plan) throw new Error('There is no plan waiting for approval in this conversation');
      type = plan.route;
      const note = typeof prompt === 'string' ? prompt.trim() : '';
      prompt = note ? `Approved — run the plan.\n${note}` : 'Approved — run the plan.';
      // Earlier turns for context; the plan itself goes in whole rather than through the clipped history.
      modelPrompt = buildPrompt(conv.messages.slice(0, -1), `${APPROVED}${note ? `\n\nExtra instructions from the user:\n${note}` : ''}\n\nApproved plan:\n${plan.text}`);
    } else {
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must be a non-empty string');
      conv = conversationId ? conversations.get(conversationId) : conversations.create({ title: prompt.trim().split('\n')[0], taskType, project });
      if (!conv) throw new Error('Conversation not found');
      type = taskType || conv.taskType;
      modelPrompt = buildPrompt(conv.messages, prompt);
    }
    const reply = await task({ taskType: type, prompt: modelPrompt, system: CHAT_SYSTEM, connector, source: 'chat', conversationId: conv.id, images, cwd, signal, onEvent });
    const refs = images.map(({ id, name, mediaType }) => ({ id, name, mediaType }));
    const userMsg = { role: 'user', text: prompt, ts: now(), ...(refs.length ? { images: refs } : {}), ...(approve ? { approved: true } : {}) };
    const where = cwd && project ? { project } : {};
    const botMsg = reply.ok
      ? { role: 'assistant', text: reply.text, ts: now(), taskId: reply.id, connector: reply.connector, model: reply.model, taskType: reply.taskType, ms: reply.ms, ...where, ...(config.routes[reply.taskType]?.readOnly ? { plan: true } : {}) }
      : { role: 'assistant', text: '', error: reply.error, ts: now(), taskId: reply.id, taskType: reply.taskType, ...where };
    const saved = conversations.append(conv.id, userMsg, botMsg);
    return { conversation: { id: saved.id, title: saved.title, project: saved.project }, reply };
  }

  return {
    task,
    chat,
    history,
    memory,
    isAgentRoute,
    // For the server: which route and project an approval in this conversation would run on, or null.
    approvalFor: (conversationId) => {
      const plan = conversations && conversationId ? pendingPlan(conversations.get(conversationId)) : null;
      return plan && { route: plan.route, project: plan.project };
    },
    usage: (sinceMs) => summarize(entries, sinceMs),
    budget: (connector, taskType) => checkBudget(entries, caps, connector, taskType, now()),
    capStatus: () => capStatus(entries, caps, now()),
    queue: () => limiter?.stats() ?? {},
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
