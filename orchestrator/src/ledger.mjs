// Usage ledger and daily budget checks. Pure; storage is a later wrapper.

const DAY_MS = 24 * 60 * 60 * 1000;

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
  if (cap.tokens !== undefined && tokens >= cap.tokens) return `${label} daily token cap reached (${tokens}/${cap.tokens})`;
  if (cap.calls !== undefined && usage.calls >= cap.calls) return `${label} daily call cap reached (${usage.calls}/${cap.calls})`;
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
  for (const k of Object.keys(caps)) if (k !== 'daily') throw new Error(`Unknown budget key "${k}" (only "daily")`);
  const daily = caps.daily;
  if (daily === undefined) return caps;
  if (!isObj(daily)) throw new Error('daily must be an object');
  for (const k of Object.keys(daily)) {
    if (!['perConnector', 'perTaskType', 'globalTokens'].includes(k)) throw new Error(`Unknown daily key "${k}"`);
  }
  if (daily.globalTokens !== undefined && !(Number.isInteger(daily.globalTokens) && daily.globalTokens >= 0)) throw new Error('daily.globalTokens must be a non-negative integer');
  for (const [group, names] of [['perConnector', known.connectors], ['perTaskType', known.taskTypes]]) {
    if (daily[group] === undefined) continue;
    if (!isObj(daily[group])) throw new Error(`daily.${group} must be an object`);
    for (const [name, cap] of Object.entries(daily[group])) {
      if (names && !names.includes(name)) throw new Error(`daily.${group} names unknown "${name}"`);
      validateCap(cap, `daily.${group}.${name}`);
    }
  }
  return caps;
}

// Every configured cap with its current 24h usage, for dashboards.
export function capStatus(entries, caps, nowMs) {
  const daily = caps?.daily;
  if (!daily) return [];
  const { total, byConnector, byTaskType } = summarize(entries, nowMs - DAY_MS);
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
  const daily = caps?.daily;
  if (!daily) return { allowed: true, reason: null };
  const { total, byConnector, byTaskType } = summarize(entries, nowMs - DAY_MS);
  const reason =
    (daily.globalTokens !== undefined ? over({ tokens: daily.globalTokens }, total, 'Global') : null) ??
    over(daily.perConnector?.[connector], byConnector[connector] ?? emptyTotals(), `Connector "${connector}"`) ??
    over(daily.perTaskType?.[taskType], byTaskType[taskType] ?? emptyTotals(), `Task type "${taskType}"`);
  return { allowed: reason === null, reason };
}
