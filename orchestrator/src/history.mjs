// Task history (data/tasks.jsonl) and chat conversations (data/conversations/<id>.json). Local only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rotateIfLarge } from './rotate.mjs';

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

export function createTaskHistory(file, { keep = 1000, maxBytes = 20_000_000, now = Date.now } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const records = [];
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  records.splice(0, Math.max(0, records.length - keep));
  return {
    append(rec) {
      const r = { ...rec, prompt: clip(rec.prompt, 4000), text: clip(rec.text, 8000) };
      records.push(r);
      if (records.length > keep) records.shift();
      rotateIfLarge(file, maxBytes, now());
      appendFileSync(file, JSON.stringify(r) + '\n');
      return r;
    },
    // Newest first.
    list(limit = 50) {
      return records.slice(-limit).reverse();
    },
  };
}

// Folds prior turns into one prompt, newest kept first, within maxChars, so CLIs stay stateless.
// A failed reply is kept as a one-line note, so the next model knows what was tried. When older turns do not fit,
// the prompt says so, so a model never mistakes a clipped history for the whole conversation.
export function buildPrompt(messages, prompt, maxChars = 12_000) {
  const turns = [];
  let used = prompt.length;
  let dropped = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const body = m.text || (m.error ? `(no answer: ${String(m.error).slice(0, 200)})` : '');
    if (!body) continue;
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${body}${m.images?.length ? ` [attached ${m.images.length} image(s)]` : ''}`;
    if (used + line.length > maxChars) {
      dropped = true;
      break;
    }
    used += line.length;
    turns.unshift(line);
  }
  if (!turns.length && !dropped) return prompt;
  // Preserve a compact intent spine even when a long reply fills the recent window.
  // Verbatim user requests keep task ownership with the user across different models.
  const requests = messages.filter(m => m.role === 'user' && m.text && !/^(ok|yes|continue|resume|proceed|try again)[\s.!]*$/i.test(m.text.trim()));
  const spine = [requests[0], ...requests.slice(-5)].filter((m,i,a) => m && a.indexOf(m) === i);
  const intent = dropped && maxChars >= 1000 ? spine.map(m => `U: ${clip(m.text, 500)}`).join('\n') : '';
  const note = dropped ? `(Earlier messages were left out to fit; task context retained below. Continue the existing task and inspect current state before repeating work.)\nTask context:\n${intent}\n\n` : '';
  return `Conversation so far:\n${note}${turns.join('\n\n')}\n\nUser's new message:\n${prompt}`;
}

const ID = /^[a-z0-9-]{8,64}$/;

export function createConversationStore(dir, { now = Date.now, newId = randomUUID } = {}) {
  const archiveDir = join(dir, 'archive');
  const trashDir = join(dir, 'trash');
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(trashDir, { recursive: true });
  const STATES = { active: dir, archived: archiveDir, trash: trashDir };
  const path = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid conversation id');
    return join(dir, `${id}.json`);
  };
  // Durable write: temp file is flushed to disk before the rename, and the previous good version is kept as <id>.json.bak.
  const write = (conv) => {
    const file = path(conv.id);
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, JSON.stringify(conv)); fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(file)) { try { copyFileSync(file, `${file}.bak`); } catch { /* snapshot is best effort */ } }
    renameSync(tmp, file);
    return conv;
  };
  const parse = (file) => JSON.parse(readFileSync(file, 'utf8'));
  // A corrupt or truncated file falls back to the retained snapshot; the damaged file is kept as .corrupt for inspection.
  const readFile = (file) => {
    try {
      return parse(file);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      try {
        const snap = parse(`${file}.bak`);
        try { copyFileSync(file, `${file}.corrupt`); copyFileSync(`${file}.bak`, file); } catch { /* still return the snapshot */ }
        return snap;
      } catch { throw err; }
    }
  };
  const read = (id) => readFile(path(id));
  const PARTIAL_MAX = 20_000;
  const FLUSH_MS = 2000;
  const pending = new Map(); // id -> { text, flushed }
  return {
    get: read,
    begin(id, user, run) {
      const conv = read(id);
      if (!conv) throw new Error('Conversation not found');
      if (conv.run?.status === 'running') throw new Error('A reply is already running in this conversation');
      if (run?.runId && conv.run?.runId === run.runId) { const e = new Error('This request was already received'); e.duplicate = true; throw e; }
      conv.messages.push(user);
      pending.delete(id);
      conv.run = { ...run, status:'running', started:now(), progress:[], partial:'' };
      conv.updated = now();
      return write(conv);
    },
    progress(id, event) {
      if (event.type === 'attempt') pending.delete(id);
      if (event.type === 'delta' && typeof event.text === 'string') {
        // Bounded writes: keep streamed text in memory and flush at most every FLUSH_MS.
        const p = pending.get(id) ?? { text: '', flushed: 0 };
        p.text = (p.text + event.text).slice(-PARTIAL_MAX);
        pending.set(id, p);
        if (now() - p.flushed < FLUSH_MS) return;
        const conv = read(id);
        if (!conv?.run || conv.run.status !== 'running') return;
        conv.run.partial = p.text; p.flushed = now();
        write(conv);
        return;
      }
      const conv = read(id);
      if (!conv?.run || conv.run.status !== 'running') return;
      const buf = pending.get(id);
      if (buf) { conv.run.partial = buf.text; buf.flushed = now(); }
      const text = event.type === 'tool' ? `${event.name}: ${event.summary ?? ''}` : event.type === 'attempt' ? `model=${event.connector}` : event.type === 'attempt-failed' ? `failed=${event.connector}: ${event.error}` : null;
      if (!text) { if (buf) write(conv); return; }
      conv.run.progress = [...conv.run.progress, clip(text, 500)].slice(-20);
      write(conv);
    },
    finish(id, bot) {
      const conv = read(id);
      if (!conv) throw new Error('Conversation not found');
      pending.delete(id);
      if (bot.error && !bot.text && conv.run?.partial) bot = { ...bot, partial: conv.run.partial };
      conv.messages.push(bot);
      if (conv.run) conv.run = { ...conv.run, status:bot.error ? 'interrupted' : 'complete', finished:now(), ...(bot.error ? {} : { partial:'' }) };
      conv.updated = now();
      return write(conv);
    },
    recoverInterrupted() {
      let count = 0;
      for (const name of readdirSync(dir).filter(n => ID.test(n.replace(/\.json$/, '')) && n.endsWith('.json'))) {
        const conv = read(name.slice(0,-5));
        if (conv?.run?.status !== 'running') continue;
        conv.run.status = 'interrupted';
        conv.messages.push({role:'assistant',...(conv.run.partial ? {partial:conv.run.partial} : {}),text:'Your request and recent activity were saved. Resume continues with that context; check partial changes before repeating operations.',error:'The service restarted before this reply finished.',recovery:{retryable:true},taskType:conv.run.route,ts:now()});
        write(conv); count++;
      }
      return count;
    },
    // Finds the conversation that received a client request id, so a client that lost the stream before the
    // conversation-id event can still locate its chat without re-sending.
    findByRun(runId) {
      if (typeof runId !== 'string') return null;
      for (const base of [dir, archiveDir]) {
        for (const name of readdirSync(base)) {
          if (!name.endsWith('.json')) continue;
          try {
            const c = readFile(join(base, name));
            if (c?.run?.runId === runId) return { id: c.id, title: c.title, status: c.run.status, started: c.run.started };
          } catch {}
        }
      }
      return null;
    },
    create({ title = 'New chat', taskType, project } = {}) {
      const t = now();
      return write({ id: newId(), title: clip(String(title), 80), taskType: taskType || undefined, project: project || undefined, created: t, updated: t, messages: [] });
    },
    append(id, ...messages) {
      const conv = read(id);
      if (!conv) throw new Error('Conversation not found');
      conv.messages.push(...messages);
      conv.updated = now();
      return write(conv);
    },
    // Standing notes on a conversation: guidance the model sees on every later turn (and on plan approval).
    addNote(id, text) {
      const conv = read(id);
      if (!conv) throw new Error('Conversation not found');
      if (typeof text !== 'string' || !text.trim()) throw new Error('note must be a non-empty string');
      (conv.notes ??= []).push({ id: newId(), ts: now(), text: clip(text.trim(), 4000) });
      conv.updated = now();
      write(conv);
      return conv.notes;
    },
    removeNote(id, noteId) {
      const conv = read(id);
      if (!conv) throw new Error('Conversation not found');
      const before = (conv.notes ?? []).length;
      conv.notes = (conv.notes ?? []).filter((n) => n.id !== noteId);
      if (conv.notes.length === before) throw new Error('Note not found');
      write(conv);
      return conv.notes;
    },
    rename(id, title) {
      const conv = read(id);
      if (!conv) throw new Error('Conversation not found');
      conv.title = clip(String(title), 80);
      return write(conv);
    },
    // Archive rather than delete, so nothing is lost by a mis-click.
    archive(id) {
      const file = path(id);
      if (!read(id)) throw new Error('Conversation not found');
      renameSync(file, join(archiveDir, `${id}.json`));
    },
    // Delete = move to data/conversations/trash. Still on disk and restorable; nothing is erased.
    trash(id) {
      const file = path(id);
      const from = existsSync(file) ? file : join(archiveDir, `${id}.json`);
      if (!existsSync(from)) throw new Error('Conversation not found');
      renameSync(from, join(trashDir, `${id}.json`));
    },
    // Move an archived or trashed conversation back to the active list.
    restore(id) {
      const file = path(id);
      for (const d of [archiveDir, trashDir]) {
        const from = join(d, `${id}.json`);
        if (existsSync(from)) { renameSync(from, file); return read(id); }
      }
      throw new Error('Conversation not found');
    },
    list(state = 'active') {
      const base = STATES[state];
      if (!base) throw new Error('state must be active, archived or trash');
      const out = [];
      for (const name of readdirSync(base)) {
        if (!name.endsWith('.json')) continue;
        try {
          const c = readFile(join(base, name));
          const last = c.messages.filter((m) => m.role === 'user').at(-1)?.text;
          out.push({ id: c.id, title: c.title, taskType: c.taskType, project: c.project, created: c.created, updated: c.updated, count: c.messages.length, preview: last ? clip(String(last).replace(/\s+/g, ' '), 140) : '' });
        } catch {}
      }
      return out.sort((a, b) => b.updated - a.updated);
    },
  };
}
