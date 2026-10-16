// In-service scheduler: runs configured commands on a timer. Replaces OpenClaw automations for plain scripts.
// Off unless config.enabled is true. Commands are argv arrays (no shell); a missed daily run catches up once.
import { spawn } from 'node:child_process';
import { collect } from './connectors/run.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateSchedule(cfg) {
  if (!isObj(cfg)) throw new Error('Schedule config must be an object');
  for (const k of Object.keys(cfg)) if (!['enabled', 'jobs'].includes(k)) throw new Error(`Unknown schedule key "${k}"`);
  if (typeof (cfg.enabled ?? false) !== 'boolean') throw new Error('enabled must be a boolean');
  const names = new Set();
  for (const job of cfg.jobs ?? []) {
    if (!isObj(job)) throw new Error('Each job must be an object');
    if (typeof job.name !== 'string' || !job.name) throw new Error('Job name must be a non-empty string');
    if (names.has(job.name)) throw new Error(`Duplicate job "${job.name}"`);
    names.add(job.name);
    const timing = ['dailyAt', 'everyMinutes'].filter((k) => job[k] !== undefined);
    if (timing.length !== 1) throw new Error(`Job "${job.name}" needs exactly one of dailyAt or everyMinutes`);
    if (job.dailyAt !== undefined && !HHMM.test(job.dailyAt)) throw new Error(`Job "${job.name}" dailyAt must be HH:MM`);
    if (job.everyMinutes !== undefined && !(Number.isInteger(job.everyMinutes) && job.everyMinutes >= 1)) throw new Error(`Job "${job.name}" everyMinutes must be a positive integer`);
    // A job either runs a command (argv array, no shell) or asks a model (prompt, optionally on an agent route in a project).
    if ([job.command, job.prompt].filter((v) => v !== undefined).length !== 1) throw new Error(`Job "${job.name}" needs exactly one of command or prompt`);
    if (job.command !== undefined && (!Array.isArray(job.command) || !job.command.length || job.command.some((c) => typeof c !== 'string' || !c))) throw new Error(`Job "${job.name}" command must be a non-empty array of strings`);
    if (job.prompt !== undefined && (typeof job.prompt !== 'string' || !job.prompt.trim())) throw new Error(`Job "${job.name}" prompt must be a non-empty string`);
    for (const k of ['taskType', 'project']) if (job[k] !== undefined && (typeof job[k] !== 'string' || !job[k])) throw new Error(`Job "${job.name}" ${k} must be a non-empty string`);
    if (job.enabled !== undefined && typeof job.enabled !== 'boolean') throw new Error(`Job "${job.name}" enabled must be a boolean`);
  }
  return cfg;
}

// last = ms timestamp of the previous run (or undefined). Local time for dailyAt.
export function isDue(job, last, nowMs) {
  if (job.everyMinutes !== undefined) return last === undefined || nowMs - last >= job.everyMinutes * 60_000;
  const [h, m] = job.dailyAt.split(':').map(Number);
  const slot = new Date(nowMs);
  slot.setHours(h, m, 0, 0);
  return nowMs >= slot.getTime() && (last === undefined || last < slot.getTime());
}

const clip = (s) => s.trim().split(/\r?\n/).slice(-5).join(' | ').slice(0, 500);

// record(entry) persists a run; lastRuns seeds state after a restart ({ jobName: ms }).
// runPrompt(job) → { ok, text?, error? } handles prompt jobs (wired to the orchestrator in main.mjs).
export function createScheduler({ config, cwd, record, runPrompt, lastRuns = {}, now = Date.now, spawnImpl = spawn, timeoutMs = 600_000, tickMs = 30_000, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  validateSchedule(config);
  const last = { ...lastRuns };
  const running = new Set();
  const results = {};
  let timer = null;

  async function runJob(job) {
    if (running.has(job.name)) return null;
    running.add(job.name);
    const ts = now();
    last[job.name] = ts;
    let entry;
    try {
      if (job.prompt !== undefined) {
        if (!runPrompt) throw new Error('Prompt jobs are not enabled');
        const r = await runPrompt(job);
        entry = { job: job.name, ts, ok: !!r.ok, code: r.ok ? 0 : 1, output: clip(String(r.ok ? r.text ?? '' : r.error ?? 'failed')) };
      } else {
        const [cmd, ...args] = job.command;
        const { code, stdout, stderr } = await collect(spawnImpl, cmd, args, { timeoutMs, cwd });
        entry = { job: job.name, ts, ok: code === 0, code, output: clip(code === 0 ? stdout : stderr || stdout) };
      }
    } catch (err) {
      entry = { job: job.name, ts, ok: false, code: null, output: err.message };
    } finally {
      running.delete(job.name);
    }
    results[job.name] = entry;
    record?.(entry);
    return entry;
  }

  async function tick() {
    if (!config.enabled) return [];
    const nowMs = now();
    const due = (config.jobs ?? []).filter((j) => j.enabled !== false && !running.has(j.name) && isDue(j, last[j.name], nowMs));
    return (await Promise.all(due.map(runJob))).filter(Boolean);
  }

  return {
    tick,
    start() {
      if (timer || !config.enabled) return false;
      timer = setTimer(() => void tick(), tickMs);
      timer.unref?.();
      void tick();
      return true;
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
    // Manual run works even when the scheduler is disabled, so jobs can be tested from the UI.
    async runNow(name) {
      const job = (config.jobs ?? []).find((j) => j.name === name);
      if (!job) throw new Error(`Unknown job "${name}"`);
      if (running.has(name)) throw new Error(`Job "${name}" is already running`);
      return runJob(job);
    },
    list: () => ({
      enabled: !!config.enabled,
      jobs: (config.jobs ?? []).map((j) => ({ ...j, running: running.has(j.name), lastRun: results[j.name] ?? (last[j.name] ? { ts: last[j.name] } : null) })),
    }),
  };
}
