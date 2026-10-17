// Background job queue: queue work, walk away. Jobs run unattended with a worker pool, auto-continue when an agent
// runs out of turns or time, retry transient failures, survive a service restart, and never wait for an approval.
// The only deliberate stop is "needs-input": the agent reports something it cannot safely do on its own.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const JOB_SYSTEM = [
  'You are running as an unattended background job. Nobody is watching and nobody will answer questions, so never ask for approval or confirmation.',
  'Choose sensible defaults, note your assumptions in the final report, and finish the whole task, including running the relevant tests.',
  'Only stop early when you are blocked by something you cannot do safely on your own: a deletion with no restorable backup, sending anything outside this PC, a purchase, publishing or pushing, or a missing credential.',
  'In that case end your reply with a line that starts with "NEEDS_INPUT:" and says exactly what you need.',
  'If you need to read or change files in a folder outside your working folder, do not give up: end your reply with a line "NEEDS_ACCESS: <absolute folder path> | <why you need it>". The owner can grant it with one click and you are then resumed.',
  'If notes from the owner appear in the task, follow them. Otherwise finish with a short report of what you did, what you verified and anything left undone.',
].join(' ');

const NEEDS_INPUT = /^\s*NEEDS_INPUT:\s*(.+)$/im;
const NEEDS_ACCESS = /^\s*NEEDS_ACCESS:\s*([^|\r\n]+?)\s*(?:\|\s*(.*))?$/im;
// Failures that mean "keep going", not "something is broken".
const CONTINUABLE = /max.?turns|timed out|timeout|context (length|window)|ran out of/i;
const ACTIVE = new Set(['queued', 'running']);
const FINISHED = new Set(['done', 'failed', 'cancelled', 'needs-input', 'needs-access']);
const WAITING = new Set(['needs-input', 'needs-access']); // stay on the board until the owner acts
const MAX_LOG = 120;
const MAX_TEXT = 60_000;

const notesBlock = (job) => (job.notes?.length ? `Notes from the owner (follow these, newest last):\n${job.notes.map((n) => `- ${n.text}`).join('\n')}` : '');

export const continuePrompt = (job) => [
  'Continue the task below from where the previous run stopped. First check the current state of the files, do not redo finished work, then carry on until the whole task is complete.',
  `Original task:\n${job.prompt}`,
  job.progress.length ? `Recent actions of the previous run:\n${job.progress.slice(-20).map((p) => `- ${p}`).join('\n')}` : '',
  job.partial ? `Last output of the previous run:\n${job.partial.slice(-4000)}` : '',
  job.plan ? `Approved plan:\n${job.plan}` : '',
  notesBlock(job),
  job.grants?.length ? `Folder access now granted to you for this job: ${job.grants.join(', ')}` : '',
].filter(Boolean).join('\n\n');

const trim = (s, n = MAX_TEXT) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);

// run({ job, step: 'plan'|'work', prompt, signal, onEvent }) -> { ok, text, error, connector, model, taskId }
export function createJobs({ file, run, vetFolder = (p) => p, grantAlways, concurrency = 2, maxAttempts = 3, maxContinues = 8, retryDelayMs = 15_000, keepFinished = 300, now = Date.now, newId = randomUUID }) {
  if (typeof run !== 'function') throw new Error('run must be a function');
  const jobs = new Map();
  const live = new Map(); // id -> AbortController for running jobs
  let paused = false;

  // ---- persistence: one JSON file, written atomically after every change ----
  function save() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ jobs: [...jobs.values()] }));
    renameSync(tmp, file);
  }
  if (file && existsSync(file)) {
    try {
      for (const j of JSON.parse(readFileSync(file, 'utf8')).jobs ?? []) {
        // A job that was running when the service stopped goes back in the queue and continues from its notes.
        if (j.status === 'running') {
          j.status = 'queued';
          j.resumed = true;
          (j.log ??= []).push({ ts: now(), msg: 'Service restarted; resuming' });
        }
        jobs.set(j.id, j);
      }
    } catch {
      // A corrupt file must not stop the service; keep a copy for inspection and start empty.
      try { renameSync(file, `${file}.corrupt-${now()}`); } catch {}
    }
  }

  const note = (job, msg) => {
    job.log.push({ ts: now(), msg });
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  };

  function prune() {
    // Jobs waiting on the owner (needs-input / needs-access) are never pruned.
    const done = [...jobs.values()].filter((j) => FINISHED.has(j.status) && !j.status.startsWith('needs-')).sort((a, b) => a.finishedAt - b.finishedAt);
    for (const j of done.slice(0, Math.max(0, done.length - keepFinished))) jobs.delete(j.id);
  }

  // Which folder (if any) should the owner be asked about? Off-limits folders are logged, never offered.
  function accessNeeded(job, text, denials = []) {
    const wanted = [];
    const m = NEEDS_ACCESS.exec(text);
    if (m) wanted.push({ path: m[1].trim(), reason: m[2]?.trim() || 'The agent asked for this folder.' });
    for (const d of denials ?? []) {
      // A refused file path: ask for its folder.
      if (d.path) wanted.push({ path: String(d.path).replace(/[\\/][^\\/]*$/, '') || String(d.path), reason: `${d.tool || 'A tool'} was refused for ${d.path}` });
    }
    for (const w of wanted) {
      let folder;
      try { folder = vetFolder(w.path); } catch (err) { note(job, `Not asking for ${w.path}: ${err.message}`); continue; }
      if (job.grants?.includes(folder) || job.deniedPaths?.includes(folder)) continue;
      return { path: folder, reason: w.reason.slice(0, 300), asked: now() };
    }
    return null;
  }

  // ---- running one job ----
  async function execute(job, ctrl) {
    const { signal } = ctrl;
    const onEvent = (ev) => {
      if (ev.type === 'tool') {
        job.progress.push(`${ev.name}: ${ev.summary ?? ''}`.slice(0, 200));
        if (job.progress.length > 40) job.progress.splice(0, job.progress.length - 40);
        job.activity = { ts: now(), text: job.progress.at(-1) };
      } else if (ev.type === 'attempt') {
        job.connector = ev.connector;
        note(job, `Trying ${ev.connector}`);
      } else if (ev.type === 'attempt-failed') note(job, `${ev.connector} failed: ${String(ev.error).slice(0, 200)}`);
    };
    const call = (step, prompt) => run({ job, step, prompt, signal, onEvent });

    if (job.planFirst && !job.plan) {
      note(job, 'Planning');
      const p = await call('plan', job.prompt);
      if (signal.aborted) return 'cancelled';
      if (!p.ok) {
        job.error = p.error;
        return 'retry';
      }
      job.plan = trim(p.text);
      note(job, 'Plan ready; running it (no approval needed for jobs)');
    }

    for (;;) {
      const prompt = job.continues > 0 || job.resumed ? continuePrompt(job) : [job.plan ? `Carry out this plan step by step, then report.\n\nTask:\n${job.prompt}\n\nPlan:\n${job.plan}` : job.prompt, notesBlock(job)].filter(Boolean).join('\n\n');
      job.resumed = false;
      note(job, job.continues ? `Continuing (part ${job.continues + 1})` : 'Working');
      const notesAtStart = job.notes?.length ?? 0;
      save();
      const r = await call('work', prompt);
      // The owner pressed "apply now" on a note: this run was cut short on purpose; go again with the note.
      if (job.interrupted) {
        job.interrupted = false;
        job.partial = trim(r.text ?? '', 8000) || job.partial;
        job.resumed = true;
        return 'again';
      }
      if (signal.aborted) return 'cancelled';
      job.tokens = (job.tokens ?? 0) + (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
      if (r.ok) {
        const text = r.text ?? '';
        const ask = NEEDS_INPUT.exec(text);
        job.result = { text: trim(text), connector: r.connector, model: r.model, taskId: r.taskId };
        if (ask) {
          job.question = ask[1].trim();
          return 'needs-input';
        }
        // The agent asked for a folder, or was refused one: park the job on a one-click request.
        const need = accessNeeded(job, text, r.denials);
        if (need) {
          job.access = need;
          return 'needs-access';
        }
        // Notes added while it was working were not seen by that run; apply them before calling the job done.
        if ((job.notes?.length ?? 0) > notesAtStart && job.continues < maxContinues) {
          job.continues += 1;
          job.partial = trim(text, 8000);
          note(job, 'A note arrived while working; applying it');
          continue;
        }
        return 'done';
      }
      job.partial = trim(r.text ?? '', 8000) || job.partial;
      job.error = r.error;
      if (CONTINUABLE.test(String(r.error)) && job.continues < maxContinues) {
        job.continues += 1;
        note(job, `Stopped early (${String(r.error).slice(0, 120)}); continuing`);
        continue;
      }
      return 'retry';
    }
  }

  async function runJob(job) {
    const ctrl = new AbortController();
    live.set(job.id, ctrl);
    job.status = 'running';
    job.startedAt ??= now();
    job.attempts += 1;
    save();
    let outcome;
    try {
      outcome = await execute(job, ctrl);
    } catch (err) {
      job.error = err.message;
      outcome = ctrl.signal.aborted ? 'cancelled' : 'retry';
    }
    live.delete(job.id);
    if (outcome === 'again') {
      job.attempts -= 1; // cutting a run short for a new note is not a failed attempt
      job.status = 'queued';
      note(job, 'Restarting to apply your note');
      save();
      return pump();
    }
    if (outcome === 'retry') {
      if (job.attempts < maxAttempts && !ctrl.signal.aborted) {
        note(job, `Attempt ${job.attempts} failed: ${String(job.error).slice(0, 200)}. Retrying in ${Math.round(retryDelayMs / 1000)} s`);
        job.status = 'queued';
        job.notBefore = now() + retryDelayMs * job.attempts;
        save();
        setTimeout(pump, retryDelayMs * job.attempts + 5).unref?.();
        return;
      }
      outcome = ctrl.signal.aborted ? 'cancelled' : 'failed';
    }
    job.status = outcome;
    job.finishedAt = now();
    if (outcome === 'done') job.error = undefined;
    note(job, outcome === 'done' ? 'Finished' : outcome === 'needs-input' ? `Needs input: ${job.question}` : outcome === 'needs-access' ? `Needs access to ${job.access.path}` : outcome === 'cancelled' ? 'Cancelled' : `Failed: ${String(job.error).slice(0, 200)}`);
    prune();
    save();
    pump();
  }

  // One running job per project folder, so two jobs never edit the same files at once.
  function pump() {
    if (paused) return;
    const running = [...jobs.values()].filter((j) => j.status === 'running');
    const busy = new Set(running.map((j) => j.project).filter(Boolean));
    let slots = concurrency - running.length;
    for (const job of jobs.values()) {
      if (slots <= 0) break;
      if (job.status !== 'queued' || (job.notBefore && job.notBefore > now())) continue;
      if (job.project && busy.has(job.project)) continue;
      if (job.project) busy.add(job.project);
      slots -= 1;
      job.status = 'running'; // claim now so a second pump cannot start it again
      runJob(job).catch((err) => { job.status = 'failed'; job.error = err.message; job.finishedAt = now(); save(); });
    }
  }

  function add(spec = {}) {
    const prompt = typeof spec.prompt === 'string' ? spec.prompt.trim() : '';
    if (!prompt) throw new Error('prompt must be a non-empty string');
    if (spec.route !== undefined && (typeof spec.route !== 'string' || !spec.route)) throw new Error('route must be a non-empty string');
    if (spec.project !== undefined && typeof spec.project !== 'string') throw new Error('project must be a string');
    const job = {
      id: newId(), title: String(spec.title || prompt.split('\n')[0]).slice(0, 120), prompt, project: spec.project || undefined, route: spec.route || undefined,
      planFirst: !!spec.planFirst, status: 'queued', createdAt: now(), attempts: 0, continues: 0, progress: [], log: [], notes: [], grants: [],
    };
    note(job, 'Queued');
    jobs.set(job.id, job);
    save();
    pump();
    return view(job);
  }

  const get = (id) => {
    const j = jobs.get(id);
    if (!j) throw new Error('Job not found');
    return j;
  };

  const view = (j, full = true) => (full ? { ...j } : { id: j.id, title: j.title, project: j.project, route: j.route, planFirst: j.planFirst, status: j.status, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, attempts: j.attempts, continues: j.continues, connector: j.connector, activity: j.activity, question: j.question, error: j.error, access: j.access, notes: j.notes?.length || undefined, tokens: j.tokens, resumed: j.resumed, summary: j.result?.text?.slice(0, 300) });

  return {
    add,
    // Several at once; a bad entry is reported and the rest are still queued.
    addMany(specs) {
      if (!Array.isArray(specs) || !specs.length) throw new Error('jobs must be a non-empty array');
      return specs.map((s) => { try { return { ok: true, job: add(s) }; } catch (err) { return { ok: false, error: err.message }; } });
    },
    list: () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((j) => view(j, false)),
    get: (id) => view(get(id)),
    cancel(id) {
      const j = get(id);
      if (j.status === 'running') live.get(id)?.abort();
      else if (j.status === 'queued') { j.status = 'cancelled'; j.finishedAt = now(); note(j, 'Cancelled'); save(); }
      else throw new Error(`Job is already ${j.status}`);
      return view(j);
    },
    // Failed, cancelled and waiting jobs go back in the queue; extra guidance is added to the task.
    retry(id, extra) {
      const j = get(id);
      if (ACTIVE.has(j.status)) throw new Error(`Job is already ${j.status}`);
      if (typeof extra === 'string' && extra.trim()) j.prompt += `\n\nExtra guidance:\n${extra.trim()}`;
      Object.assign(j, { status: 'queued', attempts: 0, continues: 0, finishedAt: undefined, error: undefined, question: undefined, access: undefined, notBefore: undefined });
      note(j, 'Re-queued');
      save();
      pump();
      return view(j);
    },
    // A note on a job's ongoing thought process.
    //   running  : picked up when the current run ends (the job then goes another round before it counts as done).
    //              apply:'now' cuts the current run short and resumes with the note straight away.
    //   queued   : included in the first prompt.
    //   finished : recorded; with apply:'now' (or any apply value) the job is re-queued to continue with it.
    addNote(id, text, { apply } = {}) {
      const j = get(id);
      if (typeof text !== 'string' || !text.trim()) throw new Error('note must be a non-empty string');
      (j.notes ??= []).push({ ts: now(), text: text.trim().slice(0, 4000) });
      note(j, `Note added${apply ? ' (apply now)' : ''}: ${text.trim().slice(0, 80)}`);
      if (j.status === 'running' && apply) {
        j.interrupted = true;
        live.get(id)?.abort();
      } else if (FINISHED.has(j.status) && apply) {
        if (j.result?.text) j.partial = j.result.text.slice(0, 8000);
        Object.assign(j, { status: 'queued', attempts: 0, continues: Math.max(1, j.continues), resumed: true, finishedAt: undefined, error: undefined, question: undefined, access: undefined, notBefore: undefined });
        note(j, 'Re-queued to apply the note');
        pump();
      }
      save();
      return view(j);
    },
    // The owner's answer to a folder-access request: 'once' (this job only), 'always' (saved), or 'deny'.
    resolveAccess(id, decision) {
      const j = get(id);
      if (j.status !== 'needs-access' || !j.access) throw new Error('This job is not waiting for access');
      if (!['once', 'always', 'deny'].includes(decision)) throw new Error('decision must be once, always or deny');
      const path = j.access.path;
      if (decision === 'deny') {
        (j.deniedPaths ??= []).push(path);
        (j.notes ??= []).push({ ts: now(), text: `Access to ${path} was denied. Do not ask for it again; finish what you can without it and say what is left.` });
        note(j, `Access to ${path} denied`);
      } else {
        if (decision === 'always') {
          if (typeof grantAlways !== 'function') throw new Error('Saving permanent access is not set up');
          grantAlways(path);
        }
        (j.grants ??= []).push(path);
        note(j, `Access to ${path} granted (${decision})`);
      }
      Object.assign(j, { status: 'queued', attempts: 0, continues: Math.max(1, j.continues), resumed: true, finishedAt: undefined, error: undefined, access: undefined, notBefore: undefined });
      save();
      pump();
      return view(j);
    },
    clearFinished() {
      let n = 0;
      for (const j of [...jobs.values()]) if (FINISHED.has(j.status) && !WAITING.has(j.status)) { jobs.delete(j.id); n += 1; }
      save();
      return { cleared: n };
    },
    pause() { paused = true; },
    resume() { paused = false; pump(); },
    get paused() { return paused; },
    stats: () => ({ queued: [...jobs.values()].filter((j) => j.status === 'queued').length, running: live.size, concurrency, paused }),
    start: pump,
    // Resolves when nothing is queued or running (tests and shutdown).
    async idle() {
      while ([...jobs.values()].some((j) => ACTIVE.has(j.status))) await new Promise((r) => setTimeout(r, 5));
    },
  };
}
