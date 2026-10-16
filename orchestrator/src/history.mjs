// Task history (data/tasks.jsonl) and chat conversations (data/conversations/<id>.json). Local only.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
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
export function buildPrompt(messages, prompt, maxChars = 12_000) {
  const turns = [];
  let used = prompt.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.text) continue;
    const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}${m.images?.length ? ` [attached ${m.images.length} image(s)]` : ''}`;
    if (used + line.length > maxChars) break;
    used += line.length;
    turns.unshift(line);
  }
  if (!turns.length) return prompt;
  return `Conversation so far:\n${turns.join('\n\n')}\n\nUser's new message:\n${prompt}`;
}

const ID = /^[a-z0-9-]{8,64}$/;

export function createConversationStore(dir, { now = Date.now, newId = randomUUID } = {}) {
  const archiveDir = join(dir, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  const path = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid conversation id');
    return join(dir, `${id}.json`);
  };
  const write = (conv) => {
    const file = path(conv.id);
    writeFileSync(`${file}.tmp`, JSON.stringify(conv));
    renameSync(`${file}.tmp`, file);
    return conv;
  };
  const read = (id) => {
    try {
      return JSON.parse(readFileSync(path(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  return {
    get: read,
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
    list() {
      const out = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const c = JSON.parse(readFileSync(join(dir, name), 'utf8'));
          out.push({ id: c.id, title: c.title, taskType: c.taskType, updated: c.updated, count: c.messages.length });
        } catch {}
      }
      return out.sort((a, b) => b.updated - a.updated);
    },
  };
}
