// Usage ledger and budget checks. Pure; storage is a later wrapper.
//
// Budgets apply per fixed block, not per rolling day: the subscription limits reset in blocks of `window.hours`
// (default 5) counted from `window.resetAt` (default 08:00 local) each morning. 08:00-13:00, 13:00-18:00, 18:00-23:00,
// 23:00-04:00, then a short 04:00-08:00 block that ends at the next reset.

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const DEFAULT_WINDOW = Object.freeze({ hours: 5, resetAt: '08:00' });
const GROUPS = ['perConnector', 'perTaskType', 'globalTokens'];

// The limits object: `caps` is canonical; `daily` is the old name and still read.
const limitsOf = (caps) => caps?.caps ?? caps?.daily;
const windowOf = (caps) => ({ ...DEFAULT_WINDOW, ...(caps?.window ?? {}) });

function anchorOn(dayMs, resetAt) {
  const [h, m] = resetAt.split(':').map(Number);
  const d = new Date(dayMs);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// The block containing nowMs: { start, end } in ms. Blocks start at the reset time and run `hours` each; the last
// block of the day is cut short at the next reset.
export function budgetWindow(caps, nowMs) {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be a finite number');
  const { hours, resetAt } = windowOf(caps);
  let anchor = anchorOn(nowMs, resetAt);
  if (anchor > nowMs) {
    const prev = new Date(anchor);
    prev.setDate(prev.getDate() - 1);
    anchor = anchorOn(prev.getTime(), resetAt);
  }
  const next = new Date(anchor);
  next.setDate(next.getDate() + 1);
  const nextAnchor = anchorOn(next.getTime(), resetAt);
  const blockMs = hours * 3_600_000;
  const start = anchor + Math.floor((nowMs - anchor) / blockMs) * blockMs;
  return { start, end: Math.min(start + blockMs, nextAnchor) };
}

const isCount = (v) => Number.isFinite(v) && v >= 0;
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;

export function makeEntry(fields) {
  if (fields === null || typeof fields !== 'object') throw new Error('Entry fields must be an object');
  const { ts, connector, taskType, inputTokens, outputTokens, costUsd = null, ok = true } = fields;
  if (!Number.isFinite(ts)) throw new Error('Entry ts must be a finite number (ms)');
  if (!nonEmpty(connector)) throw new Error('Entry connector must be a non-empty string');
  if (!nonEmpty(taskType)) throw new Error('Entry taskType must be a non-empty string');
  if (!isCount(inputTokens)) throw new Error('Entry inputTokens must be a non-negative number');
  if (!isCount(outputTokens)) throw new Error('Entry outputTokens must be a non-negative number');
  if (costUsd !== null && !isCount(costUsd)) throw new Error('Entry costUsd must be null or a non-negative number');
  if (typeof ok !== 'boolean') throw new Error('Entry ok must be a boolean');
  return Object.freeze({ ts, connector, taskType, inputTokens, outputTokens, costUsd, ok });
}

const emptyTotals = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

function add(totals, e) {
  totals.calls += 1;
  totals.inputTokens += e.inputTokens;
  totals.outputTokens += e.outputTokens;
  if (e.costUsd !== null) totals.costUsd += e.costUsd;
}

export function summarize(entries, sinceMs = 0) {
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  const total = emptyTotals();
  const byConnector = {};
  const byTaskType = {};
  for (const e of entries) {
    if (e.ts < sinceMs) continue;
    add(total, e);
    add((byConnector[e.connector] ??= emptyTotals()), e);
    add((byTaskType[e.taskType] ??= emptyTotals()), e);
  }
  return { total, byConnector, byTaskType };
}

function over(cap, usage, label) {
  if (!cap) return null;
  const tokens = usage.inputTokens + usage.outputTokens;
  if (cap.tokens !== undefined && tokens >= cap.tokens) return `${label} token cap for this block reached (${tokens}/${cap.tokens})`;
  if (cap.calls !== undefined && usage.calls >= cap.calls) return `${label} call cap for this block reached (${usage.calls}/${cap.calls})`;
  return null;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateCap(cap, label) {
  if (!isObj(cap)) throw new Error(`${label} must be an object`);
  for (const [k, v] of Object.entries(cap)) {
    if (k !== 'tokens' && k !== 'calls') throw new Error(`${label} has unknown key "${k}" (use tokens or calls)`);
    if (!Number.isInteger(v) || v < 0) throw new Error(`${label}.${k} must be a non-negative integer`);
  }
}

// known: { connectors: string[], taskTypes: string[] } catches typos in cap names.
export function validateCaps(caps, known = {}) {
  if (!isObj(caps)) throw new Error('Budget caps must be an object');
  for (const k of Object.keys(caps)) if (!['window', 'caps', 'daily'].includes(k)) throw new Error(`Unknown budget key "${k}" (use "window" and "caps")`);
  if (caps.caps !== undefined && caps.daily !== undefined) throw new Error('Use "caps" or the old "daily", not both');
  if (caps.window !== undefined) {
    const w = caps.window;
    if (!isObj(w)) throw new Error('window must be an object');
    for (const k of Object.keys(w)) if (k !== 'hours' && k !== 'resetAt') throw new Error(`Unknown window key "${k}" (hours, resetAt)`);
    if (w.hours !== undefined && !(Number.isFinite(w.hours) && w.hours > 0 && w.hours <= 24)) throw new Error('window.hours must be a number from above 0 up to 24');
    if (w.resetAt !== undefined && !HHMM.test(w.resetAt)) throw new Error('window.resetAt must be HH:MM (local time)');
  }
  const daily = limitsOf(caps);
  if (daily === undefined) return caps;
  if (!isObj(daily)) throw new Error('caps must be an object');
  for (const k of Object.keys(daily)) {
    if (!GROUPS.includes(k)) throw new Error(`Unknown caps key "${k}"`);
  }
  if (daily.globalTokens !== undefined && !(Number.isInteger(daily.globalTokens) && daily.globalTokens >= 0)) throw new Error('caps.globalTokens must be a non-negative integer');
  for (const [group, names] of [['perConnector', known.connectors], ['perTaskType', known.taskTypes]]) {
    if (daily[group] === undefined) continue;
    if (!isObj(daily[group])) throw new Error(`caps.${group} must be an object`);
    for (const [name, cap] of Object.entries(daily[group])) {
      if (names && !names.includes(name)) throw new Error(`caps.${group} names unknown "${name}"`);
      validateCap(cap, `caps.${group}.${name}`);
    }
  }
  return caps;
}

// Every configured cap with its usage in the current block, for dashboards.
export function capStatus(entries, caps, nowMs) {
  const daily = limitsOf(caps);
  if (!daily) return [];
  const { total, byConnector, byTaskType } = summarize(entries, budgetWindow(caps, nowMs).start);
  const rows = [];
  const push = (scope, name, cap, usage) => {
    if (cap.tokens !== undefined) rows.push({ scope, name, metric: 'tokens', used: usage.inputTokens + usage.outputTokens, limit: cap.tokens });
    if (cap.calls !== undefined) rows.push({ scope, name, metric: 'calls', used: usage.calls, limit: cap.calls });
  };
  if (daily.globalTokens !== undefined) push('global', 'all', { tokens: daily.globalTokens }, total);
  for (const [n, cap] of Object.entries(daily.perConnector ?? {})) push('connector', n, cap, byConnector[n] ?? emptyTotals());
  for (const [n, cap] of Object.entries(daily.perTaskType ?? {})) push('taskType', n, cap, byTaskType[n] ?? emptyTotals());
  return rows;
}

// "Reached" means the next call is refused: usage already at or above the cap.
export function checkBudget(entries, caps, connector, taskType, nowMs) {
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be a finite number');
  const daily = limitsOf(caps);
  if (!daily) return { allowed: true, reason: null };
  const { total, byConnector, byTaskType } = summarize(entries, budgetWindow(caps, nowMs).start);
  const reason =
    (daily.globalTokens !== undefined ? over({ tokens: daily.globalTokens }, total, 'Global') : null) ??
    over(daily.perConnector?.[connector], byConnector[connector] ?? emptyTotals(), `Connector "${connector}"`) ??
    over(daily.perTaskType?.[taskType], byTaskType[taskType] ?? emptyTotals(), `Task type "${taskType}"`);
  return { allowed: reason === null, reason };
}
