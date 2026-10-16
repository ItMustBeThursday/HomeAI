// "auto" chats: a cheap check on every message decides whether to answer (chat), do it (act) or plan it first (plan).
// Rules decide the obvious cases for free; a small local model decides the rest; a configured fallback covers failures.
import { mediaIntent } from './media-intent.mjs';

const AFFIRM = /^(?:(?:y|ya|yes|yep|yeah|yup|ok|okay|k|sure|go|go ahead|go for it|do it|do that|proceed|continue|approved?|sounds good|looks good|lgtm|please do|please|ship it|make it so|now|then|thanks?|thank you)[\s.!,]*)+$/i;
const SMALLTALK = /^(hi|hello|hey|thanks|thank you|thx|cheers|good (morning|afternoon|evening|night)|bye|goodbye|nice|cool|great|awesome|perfect)( there| all| so much| a lot| again| mate| homeai)?[\s.!,]*$/i;
const ACT_RULES = [
  [/\b[a-z]:\\/i, 'mentions a Windows path'],
  [/(^|\s)(\.{1,2}|~)[\\/]\S/, 'mentions a relative path'],
  [/\b[\w-]+\.(m?js|cjs|ts|tsx|jsx|py|json|md|ps1|psm1|txt|html|css|ya?ml|toml|csv|bat|cmd|sh|log|ini|cfg|env)\b/i, 'mentions a file'],
  [/^\s*(git|npm|npx|node|pnpm|yarn|pip|python|py|winget|choco|powershell|pwsh|cd|ls|dir|mkdir|rm|del|copy|move|curl|ollama|claude|codex)\b/i, 'starts with a command'],
  [/`[^`]*\b(git|npm|node|pip|python|powershell|pwsh|Get-\w+|Start-\w+)\b[^`]*`/, 'contains a command'],
  [/\b[a-z]:\s*(and|&|,|\/)?\s*([a-z]:\s*)?drives?\b|\b[a-z]\s+drive\b/i, 'mentions a drive'],
  [/\b(edit|write|create|modify|change|save|read|open|delete|fix|update|patch|rewrite)\b[^.?!\n]{0,60}\b(files?|code|folders?|director(y|ies)|scripts?|configs?|repo|source)\b/i, 'asks to work with files'],
  [/\byour (own )?(code|source|server|config|files?|settings)\b/i, 'asks about changing itself'],
  [/\b(try|run|test|execute|launch)\b[^.?!\n]{0,40}\b(shell|powershell|cmd|terminal|command|script|tests?|smoke|connector)\b/i, 'asks to run something'],
  [/\b(switch|swap)\b[^.?!\n]{0,30}\b(models?|claude|codex|ollama|opus|sonnet|haiku|agent|connector)\b/i, 'asks to switch models'],
  [/\b(can|could|would|will|please)\s+you\s+(please\s+)?(run|check|test|restart|fix|open|read|edit|write|try|install|update|publish|push|commit)\b|\byou (just |please )?(run|check|test|restart|publish|push|commit|install)\b/i, 'asks it to act'],
];
// A chat reply that says it cannot run or reach anything: a follow-up that is not a question needs the agent.
const CANT_ACT = /\b(can'?t|cannot|can not|unable to|couldn'?t|could not|no way to)\b[^.!\n]{0,60}\b(run|execute|access|check|restart|touch|read|write|edit|fix|open|reach|start|test|use)\b|\b(in this (chat|session)|from (here|this session))\b/i;
const QUESTION = /\?\s*$/;
const PLAN_RULES = [
  /\b(reorgani[sz]e|restructure|re-?arrange|clean ?up|tidy|consolidate|migrate)\b[\s\S]{0,60}\b(folders?|director(y|ies)|files|projects?|layout|structure|workspace|repo)\b/i,
  /\b(move|delete|remove|rename|archive)\s+(all|every|each|the whole|everything)\b/i,
];

export const isAffirmation = (text) => typeof text === 'string' && text.trim().length <= 60 && AFFIRM.test(text.trim());

export function validateAuto(auto, routes, connectors) {
  if (auto === undefined) return;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(auto)) throw new Error('config.auto must be an object');
  if (Object.hasOwn(routes, 'auto')) throw new Error('"auto" is reserved; no route may use that name');
  for (const k of ['chat', 'act']) if (!Object.hasOwn(routes, auto[k])) throw new Error(`config.auto.${k} must name an existing route`);
  if (routes[auto.chat].agent) throw new Error('config.auto.chat must be a route that does not run commands');
  if (!routes[auto.act].agent || routes[auto.act].readOnly) throw new Error('config.auto.act must be an agent route that can make changes');
  if (auto.plan !== undefined && !(Object.hasOwn(routes, auto.plan) && routes[auto.plan].readOnly && routes[auto.plan].then)) throw new Error('config.auto.plan must name a planning route (readOnly with then)');
  const checks = [].concat(auto.check ?? []);
  if (auto.check !== undefined && !(checks.length && checks.every((n) => typeof n === 'string' && Object.hasOwn(connectors, n)))) throw new Error('config.auto.check must name an existing connector, or list them');
  if (auto.coldTimeoutMs !== undefined && !(Number.isInteger(auto.coldTimeoutMs) && auto.coldTimeoutMs > 0)) throw new Error('config.auto.coldTimeoutMs must be a positive integer');
  if (auto.fallback !== undefined && !['chat', 'act'].includes(auto.fallback)) throw new Error('config.auto.fallback must be "chat" or "act"');
  if (auto.timeoutMs !== undefined && !(Number.isInteger(auto.timeoutMs) && auto.timeoutMs > 0)) throw new Error('config.auto.timeoutMs must be a positive integer');
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function checkPrompt(prompt, previous, withPlan) {
  const lines = [
    'Classify the LAST user message for a home assistant that can also operate a Windows PC.',
    'CHAT = it can be answered with text alone: questions, explanations, advice, opinions, writing or rewriting text, maths, small talk.',
    'ACT = it needs something done or looked up on the computer or the web: run commands, read/create/edit files, check a project, run tests, use git, install or restart something, search the web or fetch a page, anything about the current state of the PC or files. Also ACT: any question about whether you can or should touch files, code, drives or the PC, because the ACT assistant has those tools and the CHAT one does not.',
  ];
  if (withPlan) lines.push('PLAN = a large or risky change to files or folder structure (reorganising, moving or renaming many files, bulk deletes) that should be planned and approved before anything is changed.');
  lines.push(`Reply with exactly one word: ${withPlan ? 'CHAT, ACT or PLAN' : 'CHAT or ACT'}.`);
  if (previous?.text) lines.push('', `Previous assistant message (${previous.kind ?? 'unknown'}): ${clip(previous.text.replace(/\s+/g, ' '), 400)}`);
  lines.push('', `LAST user message: ${clip(prompt, 1500)}`, '', 'Answer:');
  return lines.join('\n');
}

export function parseVerdict(text, withPlan) {
  const m = /\b(CHAT|ACT|PLAN)\b/i.exec(String(text ?? ''));
  if (!m) return null;
  const v = m[1].toLowerCase();
  return v === 'plan' && !withPlan ? 'act' : v;
}

// check may list several connectors. Ollama holds one model at a time here, so the check uses whichever listed local
// model is already loaded (no swap, a few hundred ms) and only loads the first one when none is.
async function pickCheck(config, checks, loaded) {
  const local = (n) => config.connectors[n].kind === 'ollama';
  if (!checks.some(local) || !loaded) return { name: checks[0], warm: !local(checks[0]) || null };
  let names = null;
  try {
    names = await loaded();
  } catch {
    // Unknown: treat as cold.
  }
  const warm = names && checks.find((n) => !local(n) || names.has(config.connectors[n].model));
  return warm ? { name: warm, warm: true } : { name: checks[0], warm: false };
}

// run: the connector runner; limiter optional; loaded(): Set of model names Ollama has in memory.
// Returns { kind: 'chat'|'act'|'plan', route, via: 'rule'|'model'|'fallback', reason, ms }.
export function createAutoRouter({ getConfig, run, limiter, loaded, now = Date.now }) {
  return async function decide({ prompt, previous, hasImages = false, canAct = true, signal } = {}) {
    const config = getConfig();
    const auto = config.auto;
    if (!auto) throw new Error('Auto routing is not configured (config.auto)');
    const started = now();
    const withPlan = !!auto.plan;
    const chatRoute = hasImages && Object.hasOwn(config.routes, 'vision') ? 'vision' : auto.chat;
    const done = (kind, via, reason) => ({ kind, route: kind === 'act' ? auto.act : kind === 'plan' ? auto.plan : chatRoute, via, reason, ms: now() - started });
    const text = String(prompt ?? '').trim();

    const media = mediaIntent(text, config);
    if (media) return media;

    if (!canAct) return done('chat', 'rule', 'this device cannot run commands');
    if (SMALLTALK.test(text)) return done('chat', 'rule', 'small talk');
    if (isAffirmation(text) && (previous?.kind === 'act' || previous?.kind === 'plan')) return done('act', 'rule', 'go-ahead after an action');
    if (withPlan && PLAN_RULES.some((re) => re.test(text))) return done('plan', 'rule', 'bulk or restructuring change');
    // Mid-conversation: once the agent has been working, a statement or retry ("try now", a pasted error) stays with it.
    if (previous?.kind === 'act' && !QUESTION.test(text)) return done('act', 'rule', 'follow-up on an action');
    // A chat reply that said it could not act: the next statement or request is the one that needs the agent.
    if (previous?.kind === 'chat' && CANT_ACT.test(previous.text ?? '') && !QUESTION.test(text)) return done('act', 'rule', 'follow-up after a reply that could not act');
    for (const [re, why] of ACT_RULES) if (re.test(text)) return done('act', 'rule', why);

    const fallback = auto.fallback ?? 'act';
    const checks = [].concat(auto.check ?? []);
    if (!checks.length) return done(fallback, 'fallback', 'no check model configured');
    const pick = await pickCheck(config, checks, loaded);
    const c = config.connectors[pick.name];
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    // A cold model has to load first (15 s or so for the big one), so it gets longer.
    const limit = pick.warm ? auto.timeoutMs ?? 8000 : auto.coldTimeoutMs ?? 30000;
    const timer = setTimeout(() => ((timedOut = true), ctrl.abort(new Error('check timed out'))), limit);
    try {
      const entry = { connector: pick.name, kind: c.kind, model: c.model, maxTurns: 1, tools: [], brief: true };
      const call = () => run(entry, { prompt: checkPrompt(text, previous, withPlan), system: 'You are a strict message classifier. Output one word.', signal: ctrl.signal });
      const out = await (limiter ? limiter.run(c.kind, call) : call());
      const verdict = out?.ok ? parseVerdict(out.text, withPlan) : null;
      const usage = { checked: pick.name, inputTokens: out?.inputTokens ?? 0, outputTokens: out?.outputTokens ?? 0, checkOk: !!verdict };
      if (verdict) return { ...done(verdict, 'model', `${pick.name}${pick.warm === false ? ' (loaded)' : ''} said ${verdict.toUpperCase()}`), ...usage };
      return { ...done(fallback, 'fallback', out?.ok ? 'check gave no clear answer' : `check failed: ${out?.error ?? 'unknown error'}`), ...usage };
    } catch (err) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const why = timedOut ? `check timed out after ${limit} ms` : `check failed: ${err.message}`;
      return { ...done(fallback, 'fallback', why), checked: pick.name, inputTokens: 0, outputTokens: 0, checkOk: false };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
