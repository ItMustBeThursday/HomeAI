// Mini swarm: a local planner splits a task into independent sub-tasks, free hosted models work them in parallel
// (paced per provider, with fallback), and the local model merges. Hosted workers only see non-sensitive sub-task
// text. The local model is planner, final fallback and merger. Results carry provenance and are marked unverified.
import { looksSensitive } from './hosted.mjs';

export function createPacer({ now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const state = new Map(); // provider id -> { next, day, used, cooldownUntil }
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const get = (id) => {
    const s = state.get(id) ?? { next: 0, day: today(), used: 0, cooldownUntil: 0 };
    if (s.day !== today()) Object.assign(s, { day: today(), used: 0 });
    state.set(id, s);
    return s;
  };
  return {
    // Returns ms to wait, or null when the daily budget is spent or the provider is cooling down beyond maxWaitMs.
    reserve(p, maxWaitMs = 30_000) {
      const s = get(p.id);
      if (p.rpd && s.used >= Math.floor(p.rpd * 0.9)) return null; // keep 10% headroom
      const gap = p.rpm ? Math.ceil(60_000 / p.rpm) : 0;
      const at = Math.max(now(), s.next, s.cooldownUntil);
      const wait = at - now();
      if (wait > maxWaitMs) return null;
      s.next = at + gap;
      s.used += 1;
      return wait;
    },
    cooldown(p, ms = 60_000) { get(p.id).cooldownUntil = now() + ms; },
    usage: () => Object.fromEntries([...state].map(([k, v]) => [k, { used: v.used, day: v.day }])),
    sleep,
  };
}

const parseJson = (t) => {
  const m = String(t).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : null; } catch { return null; }
};

export function createSwarm({ providers, hosted, local, pacer = createPacer(), concurrency = 4, maxSubtasks = 6, log = () => {} }) {
  const enabled = () => providers.filter((p) => p.enabled !== false && p.models?.length);
  const tokens = (r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0);

  async function plan(task) {
    const out = await local({
      system: `You split tasks. Reply with ONLY a JSON array of 1-${maxSubtasks} objects {"title","prompt"}. Each prompt must be fully self-contained (workers share no context), independent of the others, and contain no secrets or personal data.`,
      prompt: task,
    });
    const subs = (parseJson(out.text) ?? [])
      .filter((s) => s && typeof s.prompt === 'string' && s.prompt.trim())
      .slice(0, maxSubtasks)
      .map((s, i) => ({ id: i + 1, title: String(s.title ?? `part ${i + 1}`).slice(0, 80), prompt: s.prompt.trim() }));
    return subs.length ? { subs, planned: true } : { subs: [{ id: 1, title: 'whole task', prompt: task }], planned: false };
  }

  async function work(sub, startAt) {
    const pool = enabled();
    const tried = [];
    for (let k = 0; k < pool.length; k++) {
      const p = pool[(startAt + k) % pool.length];
      const wait = pacer.reserve(p);
      if (wait === null) { tried.push(`${p.id}:budget`); continue; }
      if (wait > 0) await pacer.sleep(wait);
      const model = p.models[(sub.id + k) % p.models.length];
      const t0 = Date.now();
      try {
        const r = await hosted(p, model, { prompt: sub.prompt, maxTokens: p.maxTokens ?? 1024 });
        return { ...sub, worker: `${p.id}/${model}`, text: r.text, ms: Date.now() - t0, tokens: tokens(r), tried };
      } catch (err) {
        if (err.rateLimited) pacer.cooldown(p, err.retryAfterMs ?? 60_000);
        tried.push(`${p.id}:${err.rateLimited ? '429' : err.status ?? 'err'}`);
        log(`swarm: ${p.id} failed on part ${sub.id}: ${err.message}`);
      }
    }
    const t0 = Date.now();
    const r = await local({ prompt: sub.prompt });
    return { ...sub, worker: 'local-fallback', text: r.text, ms: Date.now() - t0, tokens: tokens(r), tried };
  }

  return async function run(task, { allowHosted = true } = {}) {
    if (typeof task !== 'string' || !task.trim()) throw new Error('task must be a non-empty string');
    const sensitive = looksSensitive(task); // sensitive-looking input keeps everything local
    const { subs, planned } = await plan(task);
    const useHosted = allowHosted && !sensitive && enabled().length > 0;
    const results = new Array(subs.length);
    let next = 0;
    const lane = async () => {
      while (next < subs.length) {
        const i = next++;
        const sub = subs[i];
        if (!useHosted || looksSensitive(sub.prompt)) {
          const t0 = Date.now();
          const r = await local({ prompt: sub.prompt });
          results[i] = { ...sub, worker: 'local', text: r.text, ms: Date.now() - t0, tokens: tokens(r), tried: [] };
        } else results[i] = await work(sub, i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, subs.length) }, lane));
    let answer;
    if (results.length === 1) answer = results[0].text;
    else {
      const body = results.map((r) => `### ${r.id}. ${r.title}\n${r.text}`).join('\n\n');
      answer = (await local({
        system: 'Merge the partial answers into one coherent answer to the original task. Fix contradictions, drop duplicates and mark anything doubtful. Do not invent facts.',
        prompt: `Original task:\n${task}\n\nPartial answers:\n${body}`,
      })).text;
    }
    return {
      answer, planned, hostedUsed: useHosted, blockedSensitive: sensitive, verified: false, usage: pacer.usage(),
      parts: results.map(({ id, title, worker, ms, tokens: tk, tried }) => ({ id, title, worker, ms, tokens: tk, tried })),
    };
  };
}
