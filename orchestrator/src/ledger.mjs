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
