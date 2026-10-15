// Connector health for the dashboard: is each backend reachable, installed and (for Ollama) loaded?
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { collect } from './connectors/run.mjs';

async function getJson(fetchImpl, url, ms) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function version(spawnImpl, cmd, args) {
  try {
    const { code, stdout, stderr } = await collect(spawnImpl, cmd, args, { timeoutMs: 15_000 });
    const out = (stdout || stderr).trim().split(/\r?\n/)[0];
    return code === 0 ? { ok: true, detail: out } : { ok: false, detail: out || `exit ${code}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

export function createStatusChecker({ ollamaBase = 'http://127.0.0.1:11435', claudeBin = 'claude', codexScript, nodeBin = process.execPath, fetchImpl = fetch, spawnImpl = spawn, exists = existsSync, ttlMs = 30_000, now = Date.now }) {
  let cached = null;

  async function check(config) {
    const kinds = new Set(Object.values(config.connectors).map((c) => c.kind));
    const backends = {};
    const jobs = [];
    if (kinds.has('ollama')) {
      jobs.push((async () => {
        try {
          const [tags, ps] = await Promise.all([getJson(fetchImpl, `${ollamaBase}/api/tags`, 3000), getJson(fetchImpl, `${ollamaBase}/api/ps`, 3000)]);
          backends.ollama = { ok: true, detail: ollamaBase, installed: tags.models.map((m) => m.name), loaded: ps.models.map((m) => m.name) };
        } catch (err) {
          backends.ollama = { ok: false, detail: `${ollamaBase}: ${err.message}`, installed: [], loaded: [] };
        }
      })());
    }
    if (kinds.has('claude-cli')) jobs.push(version(spawnImpl, claudeBin, ['--version']).then((r) => (backends['claude-cli'] = r)));
    if (kinds.has('codex-cli')) {
      jobs.push(
        codexScript && exists(codexScript)
          ? version(spawnImpl, nodeBin, [codexScript, '--version']).then((r) => (backends['codex-cli'] = r))
          : Promise.resolve((backends['codex-cli'] = { ok: false, detail: `codex script not found: ${codexScript ?? '(not configured)'}` })),
      );
    }
    await Promise.all(jobs);

    const connectors = {};
    for (const [name, c] of Object.entries(config.connectors)) {
      const b = backends[c.kind];
      if (c.kind === 'ollama') {
        const installed = b.installed.includes(c.model);
        connectors[name] = { kind: c.kind, model: c.model, ok: b.ok && installed, loaded: b.loaded.includes(c.model), detail: !b.ok ? 'Ollama unreachable' : installed ? null : 'model not installed' };
      } else {
        connectors[name] = { kind: c.kind, model: c.model, ok: b.ok, detail: b.ok ? null : b.detail };
      }
    }
    return { checkedAt: now(), backends, connectors };
  }

  return async function status(config, { fresh = false } = {}) {
    if (!fresh && cached && now() - cached.checkedAt < ttlMs && cached.config === config) return cached.result;
    const result = await check(config);
    cached = { checkedAt: result.checkedAt, config, result };
    return result;
  };
}
