// Small durable memory: facts and preferences a route can opt into (route.memory), instead of
// pasting everything into every prompt. One JSON file per note in data/memory; deleted notes move to data/memory/trash.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ID = /^[a-z0-9-]{8,64}$/;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

// Rough relevance: how many distinct query words appear in a note (title counts double).
export function score(note, queryWords) {
  if (!queryWords.length) return 0;
  const title = new Set(words(note.title));
  const body = new Set(words(`${note.text} ${note.tags.join(' ')}`));
  let s = 0;
  for (const w of new Set(queryWords)) s += (title.has(w) ? 2 : 0) + (body.has(w) ? 1 : 0);
  return s;
}

export function createMemoryStore(dir, { now = Date.now, newId = randomUUID } = {}) {
  const trash = join(dir, 'trash');
  mkdirSync(trash, { recursive: true });
  const file = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid memory id');
    return join(dir, `${id}.json`);
  };
  const read = (id) => {
    try {
      return JSON.parse(readFileSync(file(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  const write = (n) => {
    const f = file(n.id);
    writeFileSync(`${f}.tmp`, JSON.stringify(n, null, 2));
    renameSync(`${f}.tmp`, f);
    return n;
  };
  const clean = ({ title, text, tags = [], source }) => {
    if (typeof title !== 'string' || !title.trim()) throw new Error('title must be a non-empty string');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string');
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || !t.trim())) throw new Error('tags must be an array of non-empty strings');
    return { title: clip(title.trim(), 120), text: clip(text.trim(), 4000), tags: [...new Set(tags.map((t) => t.trim().toLowerCase()))], source: source === undefined ? undefined : String(source) };
  };
  const all = () => {
    const out = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      } catch {}
    }
    return out.sort((a, b) => b.updated - a.updated);
  };

  const store = {
    list: all,
    get: read,
    add(fields) {
      const c = clean(fields);
      // Importing the same source twice updates the note instead of duplicating it.
      const existing = c.source ? all().find((n) => n.source === c.source) : null;
      if (existing) return write({ ...existing, ...c, updated: now() });
      const t = now();
      return write({ id: newId(), ...c, created: t, updated: t });
    },
    update(id, fields) {
      const n = read(id);
      if (!n) throw new Error('Memory note not found');
      return write({ ...n, ...clean({ ...n, ...fields }), updated: now() });
    },
    remove(id) {
      if (!read(id)) throw new Error('Memory note not found');
      renameSync(file(id), join(trash, `${id}.json`));
    },
    search(query, limit = 5) {
      const q = words(query);
      return all().map((n) => ({ n, s: score(n, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.n);
    },
    // Text for a route's system prompt: always the 'core' notes, plus the best matches for this prompt.
    // tags (array) restricts to notes carrying one of those tags (core notes still apply).
    context(prompt, { tags, maxChars = 1800, limit = 4 } = {}) {
      const notes = all();
      const inScope = (n) => !Array.isArray(tags) || n.tags.includes('core') || n.tags.some((t) => tags.includes(t));
      const core = notes.filter((n) => n.tags.includes('core') && inScope(n));
      const q = words(prompt);
      const rest = notes.filter((n) => !n.tags.includes('core') && inScope(n)).map((n) => ({ n, s: score(n, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.n);
      const lines = [];
      let used = 0;
      for (const n of [...core, ...rest]) {
        const line = `- ${n.title}: ${n.text.replace(/\s+/g, ' ')}`;
        if (used + line.length > maxChars) break;
        used += line.length;
        lines.push(line);
      }
      return lines.length ? `Things to remember about the user and household:\n${lines.join('\n')}` : '';
    },
    exists: () => existsSync(dir),
  };
  return store;
}
