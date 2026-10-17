// ComfyUI connector (local image/video/music generation). Each connector names a workflow template in
// config/workflows/<name>.json (ComfyUI API format). Placeholders that are exactly "{{name}}" are filled per request.
// Only the names in VARS can appear in a template, and request settings must pass PARAM_LIMITS, so neither a model
// nor a user can change the graph itself. Outputs are downloaded into data/media so the orchestrator owns them.
import { randomUUID, randomInt } from 'node:crypto';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, extname, basename, resolve, sep } from 'node:path';

export const COMFY_URL = 'http://127.0.0.1:8188';
const VARS = ['prompt', 'negative', 'seed', 'tags', 'lyrics', 'frames', 'width', 'height', 'steps', 'fps', 'cfg', 'seconds', 'bpm'];
const NAME = /^[a-z0-9][a-z0-9-]{0,60}\.json$/;
export const MEDIA_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

// Settings a user or a connector may set. Anything else is rejected.
export const PARAM_LIMITS = {
  frames: [9, 121], width: [256, 1280], height: [256, 1280], steps: [1, 50], fps: [8, 30],
  cfg: [0.5, 10], seconds: [5, 120], bpm: [40, 200], seed: [0, 2 ** 31 - 1],
};
export const BUILTIN_DEFAULTS = { frames: 49, width: 640, height: 352, steps: 20, fps: 24, cfg: 5, seconds: 30, bpm: 110 };
// "a 15 second song" / "2 minute track" -> seconds, clamped to the allowed range. Null when the prompt names no length.
export function durationFromPrompt(text) {
  const m = /\b(\d{1,3}(?:\.\d+)?)[-\s]*(seconds?|secs?|s|minutes?|mins?|m)\b/i.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[1]) * (/^m/i.test(m[2]) ? 60 : 1);
  const [lo, hi] = PARAM_LIMITS.seconds;
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, Math.round(n))) : null;
}
const TEXT_LIMITS = { negative: 500, lyrics: 3000 };

// Checks request or connector settings. Returns a clean object; throws on unknown keys or out-of-range values.
export function checkMediaParams(params = {}, { where = 'params' } = {}) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new Error(`${where} must be an object`);
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (k in TEXT_LIMITS) {
      if (typeof v !== 'string' || v.length > TEXT_LIMITS[k]) throw new Error(`${where}.${k} must be a string of at most ${TEXT_LIMITS[k]} characters`);
      out[k] = v;
      continue;
    }
    if (!(k in PARAM_LIMITS)) throw new Error(`${where}.${k} is not a setting that can be changed`);
    const [lo, hi] = PARAM_LIMITS[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${where}.${k} must be a number from ${lo} to ${hi}`);
    if ((k === 'width' || k === 'height') && v % 32 !== 0) throw new Error(`${where}.${k} must be a multiple of 32`);
    if (k !== 'cfg' && !Number.isInteger(v)) throw new Error(`${where}.${k} must be a whole number`);
    out[k] = v;
  }
  return out;
}

// Replaces {{name}} placeholders. Unknown placeholders are an error, so a typo can't ship a broken graph.
export function fillWorkflow(node, vars) {
  if (typeof node === 'string') {
    const m = /^\{\{(\w+)\}\}$/.exec(node);
    if (!m) return node;
    if (!VARS.includes(m[1])) throw new Error(`Unknown workflow placeholder "${m[1]}"`);
    if (!(m[1] in vars)) throw new Error(`Workflow placeholder "${m[1]}" has no value`);
    return vars[m[1]];
  }
  if (Array.isArray(node)) return node.map((v) => fillWorkflow(v, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillWorkflow(v, vars)]));
  return node;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
    const t = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });

// Pulls every output file ComfyUI reports (images, videos, audio, gifs) from a history entry.
export function outputFiles(outputs) {
  const files = [];
  for (const node of Object.values(outputs ?? {})) {
    for (const list of Object.values(node ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const f of list) if (f && typeof f.filename === 'string') files.push(f);
    }
  }
  return files;
}

export function createComfyRunner({
  baseUrl = COMFY_URL,
  workflowDir,
  outDir,
  sourceOutputDir, // ComfyUI's own output folder; private runs delete their files from it
  fetchImpl = fetch,
  pollMs = 2000,
  timeoutMs = 1_800_000,
  readFile,
  makeId = randomUUID,
  seed = () => randomInt(1, 2 ** 31 - 1),
  startServer, // optional async () => void; called once when ComfyUI does not answer, then we wait for it
  startWaitMs = 180_000,
} = {}) {
  if (!workflowDir) throw new Error('comfy runner needs a workflowDir');
  if (!outDir) throw new Error('comfy runner needs an outDir');
  // privateDir: private-chat runs write into that folder instead of outDir, and the copies ComfyUI keeps (output
  // files and its history entry) are removed once downloaded.
  return async function runComfy(entry, { prompt, signal, privateDir }) {
    if (!NAME.test(entry.workflow ?? '')) throw new Error(`Bad workflow name "${entry.workflow}"`);
    const template = JSON.parse(readFile(join(workflowDir, entry.workflow), 'utf8'));
    // Order: built-in defaults, then connector defaults, then this request's settings.
    const settings = {
      ...BUILTIN_DEFAULTS,
      ...checkMediaParams(entry.defaults ?? {}, { where: 'connector defaults' }),
      ...checkMediaParams(entry.params ?? {}, { where: 'params' }),
    };
    // A length named in the prompt applies unless the request or connector set one explicitly.
    if (!('seconds' in (entry.params ?? {})) && JSON.stringify(template).includes('{{seconds}}')) {
      const named = durationFromPrompt(prompt);
      if (named) settings.seconds = named;
    }
    const negative = settings.negative ?? entry.negative ?? '';
    const lyrics = settings.lyrics ?? entry.lyrics ?? '';
    const vars = { ...settings, prompt, negative, lyrics, tags: prompt, seed: settings.seed ?? seed() };
    const graph = fillWorkflow(template, vars);

    if (startServer) {
      const up = async () => { try { return (await fetchImpl(`${baseUrl}/system_stats`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };
      if (!(await up())) {
        try { await startServer(); } catch (e) { throw new Error(`ComfyUI is not running and could not be started: ${String(e.message).slice(0, 200)}`); }
        const until = Date.now() + startWaitMs;
        while (!(await up())) {
          if (Date.now() > until) throw new Error('ComfyUI is not running and did not start in time');
          await sleep(Math.min(pollMs, 2000), signal);
        }
      }
    }
    const queue = await fetchImpl(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: makeId() }),
      signal,
    });
    if (!queue.ok) {
      const detail = (await queue.text().catch(() => '')).slice(0, 300);
      throw new Error(`ComfyUI rejected the workflow (HTTP ${queue.status}): ${detail}`);
    }
    const { prompt_id: id } = await queue.json();
    if (!id) throw new Error('ComfyUI did not return a prompt id');

    let completed = false;
    // Independent of the request signal: cancellation must not cancel cleanup itself.
    const postCleanup = async (path, body) => {
      try {
        const res = await fetchImpl(`${baseUrl}${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        console.warn(`ComfyUI cleanup ${path} failed; memory release is unverified`);
      }
    };
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        await sleep(pollMs, signal);
        if (Date.now() > deadline) throw new Error(`ComfyUI timed out after ${timeoutMs} ms`);
        const hist = await (await fetchImpl(`${baseUrl}/history/${id}`, { signal })).json();
        const item = hist[id];
        if (!item) continue;
        if (item.status?.status_str === 'error') {
          const msg = item.status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message;
          throw new Error(`ComfyUI failed: ${(msg ?? 'execution error').slice(0, 300)}`);
        }
        const files = outputFiles(item.outputs);
        if (!files.length) continue;
        const target = privateDir ?? outDir;
        mkdirSync(target, { recursive: true });
        const saved = [];
        for (const f of files) {
          const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' });
          const res = await fetchImpl(`${baseUrl}/view?${q}`, { signal });
          if (!res.ok) throw new Error(`ComfyUI file download failed (HTTP ${res.status})`);
          const dest = join(target, `${id.slice(0, 8)}-${f.filename.replace(/[^\w.-]/g, '_')}`);
          writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
          saved.push({ name: basename(dest), path: dest, kind: extname(f.filename).slice(1) });
          if (privateDir && sourceOutputDir && (f.type ?? 'output') === 'output') {
            const src = resolve(sourceOutputDir, f.subfolder ?? '', f.filename);
            if (src.startsWith(resolve(sourceOutputDir) + sep)) try { rmSync(src, { force: true }); } catch { /* reported below by the leftover check */ }
          }
        }
        if (privateDir) await postCleanup('/history', { delete: [id] });
        completed = true;
        return {
          ok: true,
          text: `Saved ${saved.map((s) => s.name).join(', ')}`,
          files: saved,
          settings: { ...vars },
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
      }
    } finally {
      if (!completed) {
        // Remove our pending job and interrupt only our running job, never another client.
        await postCleanup('/queue', { delete: [id] });
        await postCleanup('/interrupt', { prompt_id: id });
      }
      // ComfyUI otherwise caches models after success, failure, and cancellation.
      await postCleanup('/free', { unload_models: true, free_memory: true });
    }
  };
}
