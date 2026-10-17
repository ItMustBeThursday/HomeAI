// Task history (data/tasks.jsonl) and chat conversations (data/conversations/<id>.json). Local only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rotateIfLarge } from './rotate.mjs';
import { gist, focus, queryWords } from './squeeze.mjs';

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

// Folds prior turns into one prompt within maxChars, so stateless CLIs and small local models keep the thread.
// Tier 1: the newest turns verbatim (up to 55% of the budget). Tier 2: older turns as one-line gists (extractive, no model call),
// shorter the farther back. Only turns that fit in neither tier are dropped, and the prompt says how many. A failed reply stays
// a one-line note so the next model knows what was tried. Tier 2 only applies to budgets >= 1000 chars.
const TRIVIAL = /^(ok|yes|continue|resume|proceed|try again)[\s.!]*$/i;
export function buildPrompt(messages, prompt, maxChars = 12_000) {
  const bodyOf = (m, errMax = 200) => m.text || (m.error ? `(no answer: ${String(m.error).slice(0, errMax)})` : '');
  const full = messages.map((m) => {
    const body = bodyOf(m);
    return body ? `${m.role === 'user' ? 'User' : 'Assistant'}: ${body}${m.images?.length ? ` [attached ${m.images.length} image(s)]` : ''}` : '';
  });
  const total = full.reduce((n, l) => n + (l ? l.length + 2 : 0), prompt.length);
  const tiered = maxChars >= 1000 && total > maxChars;
  const verbatimLimit = tiered ? Math.floor(maxChars * 0.55) : maxChars;
  const turns = [];
  let used = prompt.length;
  let cut = -1; // index of the newest message NOT kept verbatim
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!full[i]) continue;
    if (used + full[i].length > verbatimLimit) { cut = i; break; }
    used += full[i].length;
    turns.unshift(full[i]);
  }
  if (!turns.length && cut < 0) return prompt;
  let note = '';
  if (cut >= 0) {
    const shown = [];
    let omitted = messages.slice(0, cut + 1).filter((x) => x.text || x.error).length;
    if (maxChars >= 1000) {
      let left = maxChars - used - 600 - Math.floor(maxChars * 0.25); // headroom for headings and the original-request line
      for (let i = cut; i >= 0; i--) {
        const m = messages[i];
        const src = bodyOf(m, 120);
        if (!src) continue;
        const age = cut - i; // newer-but-not-verbatim turns get fuller gists
        const size = m.role === 'user' ? (age < 6 ? 300 : 140) : age < 4 ? 260 : age < 12 ? 140 : 80;
        const line = `${m.role === 'user' ? 'U' : 'A'}: ${gist(src, size)}`;
        if (line.length + 1 > left) break;
        left -= line.length + 1;
        shown.unshift(line);
      }
      omitted = Math.max(0, omitted - shown.length);
    }
    // Recall: older turns that did NOT fit are searched for the words of the new request, so a fact stated early in a long chat
    // (a name, number, decision) still reaches every model, whatever its window. Verbatim sentences, bounded to ~25% of the budget.
    let recalled = '';
    if (maxChars >= 1000) {
      const q = queryWords(prompt);
      const need = q.length <= 3 ? 1 : 2;
      const hits = [];
      for (let i = cut; i >= 0; i--) {
        const m = messages[i];
        if (!m.text) continue;
        const have = new Set(queryWords(m.text));
        const n = q.filter((w) => have.has(w)).length;
        if (n >= need) hits.push({ i, n, m });
      }
      hits.sort((a, b) => b.n - a.n || b.i - a.i);
      let room = Math.floor(maxChars * 0.25);
      const picked = [];
      for (const x of hits.slice(0, 3)) {
        const body = focus(x.m.text, q, Math.min(400, room));
        if (room < 80 || !body) break;
        room -= body.length + 12;
        picked.push({ i: x.i, line: `${x.m.role === 'user' ? 'User' : 'Assistant'} (earlier message ${x.i + 1}): ${body}` });
      }
      recalled = picked.sort((a, b) => a.i - b.i).map((x) => x.line).join('\n');
    }
    // The first real request keeps task ownership even after its turn is condensed or dropped.
    const first = messages.find((m) => m.role === 'user' && m.text && !TRIVIAL.test(m.text.trim()));
    const intent = maxChars >= 1000 && first && messages.indexOf(first) <= cut ? `Original request: ${clip(first.text, 500)}\n` : '';
    note = `(Earlier messages were left out to fit${shown.length ? ', the nearest are condensed below' : ''}${omitted ? `; ${omitted} not shown` : ''}. Continue the existing task and inspect current state before repeating work.)\n${intent}${shown.length ? `Earlier, condensed:\n${shown.join('\n')}\n` : ''}${recalled ? `Relevant earlier messages (exact words):\n${recalled}\n` : ''}\n`;
  }
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
  const parse = (file) => {
    const conv = JSON.parse(readFileSync(file, 'utf8'));
    if (!conv || typeof conv.id !== 'string' || !ID.test(conv.id) ||
        (!file.endsWith(`${conv.id}.json`) && !file.endsWith(`${conv.id}.json.bak`)) ||
        !Array.isArray(conv.messages)) throw new Error('Invalid conversation snapshot');
    return conv;
  };
  // A corrupt or truncated file falls back to the retained snapshot; the damaged file is kept as .corrupt for inspection.
  const readFile = (file) => {
    try {
      return parse(file);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      try {
        const snap = parse(`${file}.bak`);
        try {
          if (existsSync(file)) copyFileSync(file, `${file}.corrupt`);
          copyFileSync(`${file}.bak`, file);
        } catch { /* still return the snapshot */ }
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
      // Keep request identities on their turns: replacing conv.run must not allow
      // a delayed transport retry to execute an older request again.
      const previousUser = conv.messages.findLast(m => m.role === 'user');
      if (previousUser && conv.run?.runId) previousUser.runId ??= conv.run.runId;
      conv.messages.push({ ...user, ...(run?.runId ? { runId: run.runId } : {}) });
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
      const buffered = pending.get(id);
      if (buffered && conv.run) conv.run.partial = buffered.text;
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
        let conv;
        try { conv = read(name.slice(0,-5)); }
        catch { console.warn(`Conversation ${name.slice(0,-5)} could not be recovered; files retained`); continue; }
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
            const turn = c?.messages.find(m => m.role === 'user' && m.runId === runId);
            if (turn) return { id: c.id, title: c.title, status: 'received', started: turn.ts };
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
      const conv = read(id);
      if (!conv) throw new Error('Conversation not found');
      if (conv.run?.status === 'running') throw new Error('Stop the running reply before archiving this conversation');
      renameSync(file, join(archiveDir, `${id}.json`));
    },
    // Delete = move to data/conversations/trash. Still on disk and restorable; nothing is erased.
    trash(id) {
      const file = path(id);
      const from = existsSync(file) ? file : join(archiveDir, `${id}.json`);
      if (!existsSync(from)) throw new Error('Conversation not found');
      if (readFile(from)?.run?.status === 'running') throw new Error('Stop the running reply before trashing this conversation');
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
          out.push({ id: c.id, title: c.title, taskType: c.taskType, project: c.project, created: c.created, updated: c.updated, count: c.messages.length, running: c.run?.status === 'running', preview: last ? clip(String(last).replace(/\s+/g, ' '), 140) : '' });
        } catch {}
      }
      return out.sort((a, b) => b.updated - a.updated);
    },
  };
}
