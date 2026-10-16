// Small durable memory: facts and preferences a route can opt into (route.memory), instead of
// pasting everything into every prompt. One JSON file per note in data/memory; deleted notes move to data/memory/trash.
//
// Retrieval: keyword overlap always works. When an embedder is given (local Ollama embedding model), contextAsync()
// also ranks by cosine similarity, so "wifi password" finds a note titled "Router login". Vectors are stored in the
// note file as `vec` + `vmodel`, and are stripped from everything the API returns.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ID = /^[a-z0-9-]{8,64}$/;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Stopwords are ignored so "the" or "what" alone never makes a note match.
const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'with', 'what', 'whats', 'this', 'that', 'from', 'have', 'has', 'had', 'not', 'you', 'your', 'our', 'its', 'but', 'how', 'who', 'when', 'where', 'why', 'can', 'did', 'does', 'out', 'into', 'about', 'there', 'their', 'them', 'they', 'his', 'her', 'she', 'him', 'any', 'all', 'one', 'get', 'got', 'let', 'use', 'just', 'some', 'more', 'than', 'then', 'also', 'will', 'would', 'should', 'could', 'been', 'being', 'very', 'too', 'now']);
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));
const SEMANTIC_MIN = 0.5; // cosine similarity below this is not a match on its own
const publicNote = ({ vec, vmodel, ...n }) => n;

// Rough relevance: how many distinct query words appear in a note (title counts double).
export function score(note, queryWords) {
  if (!queryWords.length) return 0;
  const title = new Set(words(note.title));
  const body = new Set(words(`${note.text} ${note.tags.join(' ')}`));
  let s = 0;
  for (const w of new Set(queryWords)) s += (title.has(w) ? 2 : 0) + (body.has(w) ? 1 : 0);
  return s;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const textFor = (n) => `${n.title}\n${n.text}\n${n.tags.join(' ')}`;

// embedder: { model: string, embed: async (texts[]) => number[][] }  (optional)
export function createMemoryStore(dir, { now = Date.now, newId = randomUUID, embedder = null } = {}) {
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
  // Raw notes, including vectors (internal use only).
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
  const rank = (notes, q, qv, { tags, limit }) => {
    const inScope = (n) => !Array.isArray(tags) || n.tags.includes('core') || n.tags.some((t) => tags.includes(t));
    const core = notes.filter((n) => n.tags.includes('core') && inScope(n));
    const maxKw = Math.max(1, ...notes.map((n) => score(n, q)));
    const rest = notes
      .filter((n) => !n.tags.includes('core') && inScope(n))
      .map((n) => {
        const kw = score(n, q);
        const cos = qv && n.vec ? cosine(qv, n.vec) : 0;
        return { n, kw, cos, s: 0.4 * (kw / maxKw) + 0.6 * Math.max(0, cos) };
      })
      .filter((x) => x.kw > 0 || x.cos >= SEMANTIC_MIN)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.n);
    return [...core, ...rest];
  };
  const render = (picked, maxChars) => {
    const lines = [];
    let used = 0;
    for (const n of picked) {
      const line = `- ${n.title}: ${n.text.replace(/\s+/g, ' ')}`;
      if (used + line.length > maxChars) break;
      used += line.length;
      lines.push(line);
    }
    return lines.length ? `Things to remember about the user and household:\n${lines.join('\n')}` : '';
  };

  const store = {
    list: () => all().map(publicNote),
    get: (id) => {
      const n = read(id);
      return n ? publicNote(n) : null;
    },
    add(fields) {
      const c = clean(fields);
      // Importing the same source twice updates the note instead of duplicating it.
      const existing = c.source ? all().find((n) => n.source === c.source) : null;
      if (existing) return publicNote(write({ ...existing, ...c, updated: now() }));
      const t = now();
      return publicNote(write({ id: newId(), ...c, created: t, updated: t }));
    },
    update(id, fields) {
      const n = read(id);
      if (!n) throw new Error('Memory note not found');
      // Text or tag changes make the stored vector stale; it is recomputed on the next semantic search.
      const { vec, vmodel, ...rest } = n;
      const c = clean({ ...rest, ...fields });
      const changed = c.title !== n.title || c.text !== n.text || c.tags.join() !== n.tags.join();
      return publicNote(write({ ...rest, ...c, updated: now(), ...(changed ? {} : { vec, vmodel }) }));
    },
    remove(id) {
      if (!read(id)) throw new Error('Memory note not found');
      renameSync(file(id), join(trash, `${id}.json`));
    },
    search(query, limit = 5) {
      const q = words(query);
      return all().map((n) => ({ n, s: score(n, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => publicNote(x.n));
    },
    // Text for a route's system prompt: always the 'core' notes, plus the best matches for this prompt.
    // tags (array) restricts to notes carrying one of those tags (core notes still apply).
    context(prompt, { tags, maxChars = 1800, limit = 4 } = {}) {
      return render(rank(all(), words(prompt), null, { tags, limit }), maxChars);
    },
    // Semantic version of context(). Falls back to keyword matching if the embedder is missing or fails.
    async contextAsync(prompt, opts = {}) {
      if (!embedder) return store.context(prompt, opts);
      const { tags, maxChars = 1800, limit = 4 } = opts;
      let qv = null;
      try {
        [qv] = await embedder.embed([prompt]);
        await indexMissing();
      } catch {
        return store.context(prompt, opts);
      }
      return render(rank(all(), words(prompt), qv, { tags, limit }), maxChars);
    },
    // Computes vectors for notes that have none (or were made with another model). Returns how many were embedded.
    async indexMissing() {
      if (!embedder) return 0;
      return indexMissing();
    },
    exists: () => existsSync(dir),
  };

  async function indexMissing() {
    const todo = all().filter((n) => !(n.vec && n.vmodel === embedder.model));
    if (!todo.length) return 0;
    const vectors = await embedder.embed(todo.map(textFor));
    todo.forEach((n, i) => write({ ...n, vec: vectors[i], vmodel: embedder.model }));
    return todo.length;
  }

  return store;
}
