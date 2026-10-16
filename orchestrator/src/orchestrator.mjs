// Ties routing, budgets, execution and the ledger together.
import { randomUUID } from 'node:crypto';
import { validateRoutes, resolveChain, comfyFields } from './router.mjs';
import { makeEntry, summarize, capStatus, budgetWindow, validateCaps } from './ledger.mjs';
import { buildPrompt } from './history.mjs';
import { createAutoRouter } from './autoroute.mjs';
import { mediaIntent } from './media-intent.mjs';

const SHARED_SYSTEM = [
  'Use the tools actually available in this run to inspect, change and verify the local system when asked. Do the authorized work yourself; do not hand the user shell commands to run.',
  'Never claim shell or filesystem tools are unavailable without checking the current tool capabilities and observed errors. Text-only routes have no shell; explain that accurately and direct local work to an action route rather than inventing execution.',
  'Continue authorized work without repeatedly asking for permission. Planning mode remains read-only. Report only observed results; label anything unverified unverified.',
  'Local token and usage counters are informational only and never block requests. Real provider errors must be reported accurately with secrets redacted.',
  'Never access OneDrive. Never print or commit secrets. Keep a verified restorable backup before deletion. External communication, purchases, paid spend, pushing or publishing require explicit user approval. Keep OpenClaw running until explicit cutover approval.',
].join(' ');

const CHAT_SYSTEM = 'You are HomeAI, a helpful assistant for a family home. Answer clearly and concisely.';
const AGENT_SYSTEM = [
  'You are HomeAI working as a coding and operations agent on this PC. Your working directory is the selected project, but you may also read and change files on any drive (C:, D:, E:) by absolute path, except OneDrive.',
  'You may run shell commands, read and edit files, install and configure software the current Windows user can, run tests and use git. Make the change, run the relevant tests, and report what you did and the results. Do not ask for permission to work outside the project folder; just do it.',
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

// loadedModels(): Set of model names Ollama has in memory (lets the auto-route check avoid swapping models).
export function createOrchestrator({ config, caps = {}, store, history, conversations, memory, run, limiter, dirsFor, loadedModels, workspaceContext, now = Date.now, newId = randomUUID }) {
  validateRoutes(config);
  validateCaps(caps, { connectors: Object.keys(config.connectors), taskTypes: Object.keys(config.routes) });
  if (typeof run !== 'function') throw new Error('run must be a function');
  const entries = store ? store.load() : [];

  let usageResetAt = store?.loadReset?.() ?? -1;
  const visibleEntries = () => entries.filter(e => e.ts > usageResetAt);

  function record(fields) {
    const entry = makeEntry({ ts: Math.max(now(), usageResetAt + 1), ...fields });
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

  // Auto chats: the cheap check picks the route for each message. The previous reply's route gives it context.
  const decide = createAutoRouter({ getConfig: () => config, run, limiter, loaded: loadedModels, now });
  async function autoRoute({ conversationId, prompt, hasImages = false, canAct = true, signal } = {}) {
    const conv = conversationId && conversations ? conversations.get(conversationId) : null;
    // The last reply, including a failed one (so "try again" knows what failed). Kind comes from the route's flags,
    // so any agent route counts as an action and any read-only planning route as a plan.
    const last = conv?.messages.findLast((m) => m.role === 'assistant' && (m.text || m.error));
    const kindOf = (t) => (config.routes[t]?.readOnly ? 'plan' : config.routes[t]?.agent ? 'act' : 'chat');
    const previous = last ? { text: last.text || `(failed: ${last.error})`, kind: kindOf(last.taskType) } : null;
    const d = await decide({ prompt, previous, hasImages, canAct, signal });
    if (d.checked) record({ connector: d.checked, taskType: 'auto', inputTokens: d.inputTokens, outputTokens: d.outputTokens, costUsd: 0, ok: d.checkOk });
    return { kind: d.kind, route: d.route, via: d.via, reason: d.reason, ms: d.ms };
  }

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

  // connector is preferred first (usage is informational), then compatible configured route alternatives.
  // images: attachments already stored on disk. cwd: project directory (agent routes only).
  // onEvent receives {type:'attempt'|'delta'|'tool'|'attempt-failed', ...} while the model works; signal cancels.
  async function task({ taskType, prompt, system, connector, params, source = 'api', conversationId, images = [], cwd, addDirs = [], signal, onEvent } = {}) {
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
      const preferred = { connector, kind: c.kind, model: c.model, maxTurns: r.maxTurns ?? 1, tools: r.tools ?? [], ...(c.vision ? { vision: true } : {}), ...(r.agent ? { agent: true } : {}), ...(r.readOnly ? { readOnly: true } : {}), ...comfyFields(c) };
      // A preference must not become a dead end. Only use the configured route's
      // compatible alternatives: never turn media into text or actions into chat.
      chain = [preferred, ...chain.filter(e => e.connector !== connector &&
        (c.kind === 'comfyui' ? e.kind === 'comfyui' && e.media === c.media : e.kind !== 'comfyui') &&
        (!r.agent || ['claude-cli','codex-cli'].includes(e.kind)))];
    }
    // Media settings (size, length, steps...) travel with the request; the runner checks them against fixed limits.
    if (params !== undefined) chain = chain.map((e) => (e.kind === 'comfyui' ? { ...e, params } : e));
    let sys = system;
    if (r.agent) sys = [r.readOnly ? PLAN_SYSTEM : AGENT_SYSTEM, sys].filter(Boolean).join('\n\n');
    if (r.agent && workspaceContext) sys = [sys, workspaceContext()].filter(Boolean).join('\n\n');
    if (r.memory && memory) {
      const mem = await memory.contextAsync(prompt, { tags: Array.isArray(r.memory) ? r.memory : undefined });
      if (mem) sys = [sys, mem].filter(Boolean).join('\n\n');
    }
    sys = [SHARED_SYSTEM, sys].filter(Boolean).join("\n\n");
    const id = newId();
    const begun = now();
    const attempts = [];
    let result = { ok: false, error: 'Every connector in the route failed', taskType: route };
    for (const entry of chain) {
      if (signal?.aborted) {
        result = { ok: false, error: 'Cancelled', cancelled: true, taskType: route };
        break;
      }
      if (r.agent && !['claude-cli', 'codex-cli'].includes(entry.kind)) {
        attempts.push({ connector:entry.connector, model:entry.model, skipped:'cannot run project tools' });
        onEvent?.({ type:'attempt-skipped', connector:entry.connector, reason:'cannot run project tools' });
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
        return run(entry, { prompt, system: sys, images, cwd, addDirs: [...addDirs, ...(dirsFor?.({ readOnly: !!entry.readOnly, kind: entry.kind }) ?? [])], signal, onEvent: onEvent ? emit : undefined });
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
        result = { ok: true, text: out.text, connector: entry.connector, model: entry.model, taskType: route, ...(out.denials ? { denials: out.denials } : {}), ...(out.files ? { files: out.files.map(({ name, kind }) => ({ name, kind })), settings: out.settings } : {}) };
        break;
      }
      attempts.push({ ...attempt, error: out.error ?? 'connector reported failure' });
      onEvent?.({ type: 'attempt-failed', connector: entry.connector, error: out.error ?? 'connector reported failure' });
      if (out.cancelled) {
        result = { ok: false, error: 'Cancelled', cancelled: true, taskType: route };
        break;
      }
    }
    if (!result.ok && !result.cancelled) {
      const blocked = attempts.length > 0 && attempts.every(a => a.skipped);
      result = { ...result, code: blocked ? 'route_blocked' : 'connectors_failed',
        error: blocked ? 'No compatible model is available for this request.' : 'The available models could not complete this request.',
        text: blocked ? 'Your request was not run. Your message is saved; choose a compatible model and retry.' : 'The models returned an error. Your message is saved; you can retry from this conversation. Check attempt details before retrying work that may have partially completed.',
        recovery: { retryable: true } };
    }
    result = { id, ...result, attempts, ms: now() - begun };
    history?.append({ ...result, ts: begun, source, conversationId, prompt, pinned: connector, images: images.length || undefined, project: cwd });
    return result;
  }

  // Multi-turn chat: prior turns are folded into the prompt (the CLIs are stateless).
  // approve: carry out the plan that ends the conversation, on the planning route's `then` route (prompt optional;
  // it is added as extra instructions). The caller resolves cwd for that route (see approvalFor).
  // auto: the autoRoute decision for this message; the conversation stays an "auto" one and the reply records why.
  async function chat({ conversationId, prompt, taskType, connector, params, runId, images = [], cwd, project, approve = false, auto, signal, onEvent } = {}) {
    if (!conversations) throw new Error('Chat is not enabled');
    // A repeated request id (client retry after a lost stream) resolves to the chat it already created; nothing re-runs.
    const prior = runId && conversations.findByRun?.(runId);
    if (prior) { onEvent?.({ type: 'conversation', id: prior.id }); return { duplicate: true, conversation: { id: prior.id, title: prior.title }, reply: { ok: true, duplicate: true, text: '', run: prior.status } }; }
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
      conv = conversationId ? conversations.get(conversationId) : conversations.create({ title: prompt.trim().split('\n')[0], taskType: auto ? 'auto' : taskType, project });
      if (!conv) throw new Error('Conversation not found');
      type = auto ? auto.route : taskType || conv.taskType;
      modelPrompt = buildPrompt(conv.messages, prompt);
    }
    const notes = conv.notes?.length ? `Notes the user pinned to this conversation (follow them):\n${conv.notes.map((n) => `- ${n.text}`).join('\n')}` : '';
    const lastMedia = conv.messages.findLast(m => m.role === 'assistant' && config.connectors[m.connector]?.kind === 'comfyui');
    const priorMediaRoute = config.routes[conv.run?.route]?.chain.some(n => config.connectors[n]?.kind === 'comfyui') ? conv.run.route : lastMedia?.taskType;
    const media = !approve && mediaIntent(prompt, config, priorMediaRoute);
    if (media) {
      type = media.route;
      cwd = undefined;
      // A text model preference must not capture an explicit generation request.
      if (connector && config.connectors[connector]?.kind !== 'comfyui') connector = undefined;
      onEvent?.({ type:'routed', ...media });
    }
    const isMedia = config.routes[type]?.chain.some(n => config.connectors[n]?.kind === 'comfyui');
    if (isMedia) {
      // Diffusion models need the scene, not a transcript containing assistant replies.
      modelPrompt = media && /^(?:please\s+)?(?:resume|continue|try again|retry|again|make it|same |another )/i.test(prompt.trim())
        ? `${conv.run?.mediaPrompt ?? conv.messages.findLast(m => m.role === 'user')?.text ?? ''}\n${prompt}` : prompt;
      if (images.length) throw new Error('Attached-image media generation is not configured yet. Describe the scene to generate from text.');
    }
    const resume = conv.run?.status === 'interrupted' ? `Saved interrupted task (inspect current files before repeating operations):\n${conv.run.prompt}\nRecent observed activity:\n${conv.run.progress.join('\n')}\n${conv.run.partial ? `Partial reply text before the interruption (unverified, may be incomplete):\n${conv.run.partial.slice(-4000)}\n` : ''}` : '';
    if (resume && !isMedia) modelPrompt = `${resume}\n${modelPrompt}`;
    const refs = images.map(({ id, name, mediaType }) => ({ id, name, mediaType }));
    const userMsg = { role: 'user', text: prompt, ts: now(), ...(refs.length ? { images: refs } : {}), ...(approve ? { approved: true } : {}) };
    try {
      conversations.begin(conv.id, userMsg, { route:type, prompt, runId, ...(isMedia ? {mediaPrompt:modelPrompt} : {}) });
    } catch (err) {
      // A retried transport request with the same id must not run the model a second time.
      if (err.duplicate) { onEvent?.({ type: 'conversation', id: conv.id }); const cur = conversations.get(conv.id); return { duplicate: true, conversation: { id: cur.id, title: cur.title, project: cur.project }, reply: { ok: true, duplicate: true, text: '', run: cur.run?.status } }; }
      throw err;
    }
    // Lets a client that loses its connection find the conversation that will receive the reply.
    onEvent?.({ type: 'conversation', id: conv.id });
    let reply;
    try {
      reply = await task({ taskType: type, prompt: modelPrompt, system: [CHAT_SYSTEM, notes].filter(Boolean).join('\n\n'), connector, params, source: 'chat', conversationId: conv.id, images, cwd, signal, onEvent: ev => { conversations.progress(conv.id, ev); onEvent?.(ev); } });
    } catch (err) {
      conversations.finish(conv.id, {role:'assistant',text:'The request was saved. Resume after checking partial changes.',error:err.message,taskType:type,ts:now()});
      throw err;
    }
    const where = cwd && project ? { project } : {};
    const why = auto ? { auto: { via: auto.via, reason: auto.reason, ms: auto.ms } } : {};
    const botMsg = reply.ok
      ? { role: 'assistant', text: reply.text, ...(reply.files ? { files: reply.files } : {}), attempts: reply.attempts, ts: now(), taskId: reply.id, connector: reply.connector, model: reply.model, taskType: reply.taskType, ms: reply.ms, ...where, ...why, ...(config.routes[reply.taskType]?.readOnly ? { plan: true } : {}) }
      : { role: 'assistant', text: reply.text ?? '', error: reply.error, attempts: reply.attempts, recovery: reply.recovery, ts: now(), taskId: reply.id, taskType: reply.taskType, ...where, ...why };
    const saved = conversations.finish(conv.id, botMsg);
    return { conversation: { id: saved.id, title: saved.title, project: saved.project }, reply: { ...reply, ...why, ...(botMsg.plan ? { plan: true } : {}) } };
  }

  return {
    task,
    chat,
    history,
    memory,
    isAgentRoute,
    autoRoute,
    // For the server: which route and project an approval in this conversation would run on, or null.
    approvalFor: (conversationId) => {
      const plan = conversations && conversationId ? pendingPlan(conversations.get(conversationId)) : null;
      return plan && { route: plan.route, project: plan.project };
    },
    usage: (sinceMs) => summarize(visibleEntries(), sinceMs),
    clearUsage() {
      const cutoff = entries.reduce((cutoff, e) => Math.max(cutoff, e.ts), now());
      store?.saveReset?.(cutoff);
      usageResetAt = cutoff;
      return { ok: true, resetAt: cutoff };
    },
    budget: () => ({ allowed: true, reason: null }),
    capStatus: () => capStatus(visibleEntries(), caps, now()).map(c => ({ ...c, informational: true })),
    budgetWindow: () => budgetWindow(caps, now()),
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
