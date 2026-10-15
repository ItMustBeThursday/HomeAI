// Ties routing, budgets, execution and the ledger together.
import { validateRoutes, resolveChain } from './router.mjs';
import { makeEntry, summarize, checkBudget } from './ledger.mjs';

export function createOrchestrator({ config, caps = {}, store, run, now = Date.now }) {
  validateRoutes(config);
  if (typeof run !== 'function') throw new Error('run must be a function');
  const entries = store ? store.load() : [];

  function record(fields) {
    const entry = makeEntry({ ts: now(), ...fields });
    entries.push(entry);
    store?.append(entry);
    return entry;
  }

  async function task({ taskType, prompt, system } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt must be a non-empty string');
    if (system !== undefined && typeof system !== 'string') throw new Error('system must be a string');
    const type = typeof taskType === 'string' && taskType ? taskType : config.default;
    const route = Object.hasOwn(config.routes, type) ? type : config.default;
    const attempts = [];
    for (const entry of resolveChain(config, route)) {
      const budget = checkBudget(entries, caps, entry.connector, route, now());
      if (!budget.allowed) {
        attempts.push({ connector: entry.connector, model: entry.model, skipped: budget.reason });
        continue;
      }
      const started = now();
      let result;
      try {
        result = await run(entry, { prompt, system });
      } catch (err) {
        result = { ok: false, error: err.message, inputTokens: 0, outputTokens: 0, costUsd: null };
      }
      const ms = now() - started;
      record({ connector: entry.connector, taskType: route, inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0, costUsd: result.costUsd ?? null, ok: !!result.ok });
      const attempt = { connector: entry.connector, model: entry.model, ok: !!result.ok, ms, inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0 };
      if (result.ok) {
        attempts.push(attempt);
        return { ok: true, text: result.text, connector: entry.connector, model: entry.model, taskType: route, attempts };
      }
      attempts.push({ ...attempt, error: result.error ?? 'connector reported failure' });
    }
    return { ok: false, error: 'Every connector in the route failed or was over budget', taskType: route, attempts };
  }

  return {
    task,
    usage: (sinceMs) => summarize(entries, sinceMs),
    budget: (connector, taskType) => checkBudget(entries, caps, connector, taskType, now()),
    get config() {
      return config;
    },
    get caps() {
      return caps;
    },
  };
}
