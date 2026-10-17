// Small durable memory: facts and preferences a route can opt into (route.memory), instead of
// pasting everything into every prompt. One JSON file per note in data/memory; deleted notes move to data/memory/trash.
//
// Retrieval: keyword overlap always works. When an embedder is given (local Ollama embedding model), contextAsync()
// also ranks by cosine similarity, so "wifi password" finds a note titled "Router login". Vectors are stored in the
// note file as `vec` + `vmodel`, and are stripped from everything the API returns.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync, openSync, fsyncSync, closeSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as mcl from './mcl.mjs';
import { focus } from './squeeze.mjs';

const ID = /^[a-z0-9-]{8,64}$/;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Stopwords are ignored so "the" or "what" alone never makes a note match.
const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'with', 'what', 'whats', 'this', 'that', 'from', 'have', 'has', 'had', 'not', 'you', 'your', 'our', 'its', 'but', 'how', 'who', 'when', 'where', 'why', 'can', 'did', 'does', 'out', 'into', 'about', 'there', 'their', 'them', 'they', 'his', 'her', 'she', 'him', 'any', 'all', 'one', 'get', 'got', 'let', 'use', 'just', 'some', 'more', 'than', 'then', 'also', 'will', 'would', 'should', 'could', 'been', 'being', 'very', 'too', 'now']);
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));
const SEMANTIC_MIN = 0.5; // cosine similarity below this is not a match on its own
const publicNote = ({ vec, vmodel, ...n }) => n;
// Only identical source text is redundant. Word overlap loses negation, short numbers,
// case-sensitive paths and corrections. Preserve provenance distinctions between kinds/scopes.
const duplicateKey = (n) => JSON.stringify([n.kind ?? 'fact', n.scope ?? '', n.tags.includes('episode') ? '' : n.title,
  n.text.replace(/\s+/g, ' ').trim(), [...n.tags].sort()]);
const distinctNotes = (notes) => {
  const seen = new Set();
  return notes.filter(n => { const key = duplicateKey(n); if (seen.has(key)) return false; seen.add(key); return true; });
};
// Small models often copy the first matching value. Label explicit status words from the source text so every model
// sees the same cue. Labels are derived at render time only; stored notes are unchanged.
const OLD_RE = /\b(?:obsolete|superseded|outdated|deprecated|no longer (?:current|valid|true))\b/i;
const NEW_RE = /\b(?:correction|corrected|now current|supersedes)\b|\bcurrent:/i;
const currency = (text) => (NEW_RE.test(text) ? "[CURRENT] " : OLD_RE.test(text) ? "[SUPERSEDED, do not use] " : "");
// Select by relevance first, then restore turn order within each selected conversation.
// Otherwise a lower-ranked obsolete value can appear AFTER its explicit correction.
function sourceOrder(records) {
  const groups = new Map();
  for (const r of records) {
    const m = r.refs?.[0]?.match(/^turn:([^:]+):(\d+):(\d+)$/);
    if (!m) continue;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push({ r, turn: Number(m[2]), chunk: Number(m[3]) });
  }
  for (const group of groups.values()) group.sort((a, b) => a.turn - b.turn || a.chunk - b.chunk);
  return records.map(r => {
    const m = r.refs?.[0]?.match(/^turn:([^:]+):(\d+):(\d+)$/);
    return m ? groups.get(m[1]).shift().r : r;
  });
}

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
  let sourceIndex;
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
      try { return JSON.parse(readFileSync(`${file(id)}.bak`, 'utf8')); } catch {}
      throw err;
    }
  };
  const write = (n) => {
    const f = file(n.id);
    writeFileSync(`${f}.tmp`, JSON.stringify(n, null, 2));
    const fd = openSync(`${f}.tmp`, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (existsSync(f)) {
      // Keep the last parseable snapshot; never overwrite it with a corrupt primary.
      try { JSON.parse(readFileSync(f, 'utf8')); copyFileSync(f, `${f}.bak`); }
      catch (err) { if (!(err instanceof SyntaxError)) throw err; }
    }
    renameSync(`${f}.tmp`, f);
    return n;
  };
  const clean = ({ title, text, tags = [], source, kind, scope, pri, keyless }) => {
    if (typeof title !== 'string' || !title.trim()) throw new Error('title must be a non-empty string');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string');
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || !t.trim())) throw new Error('tags must be an array of non-empty strings');
    if (kind !== undefined && !Object.hasOwn(mcl.SIGILS, kind)) throw new Error('kind must be one of ' + Object.keys(mcl.SIGILS).join(', '));
    if (pri !== undefined && !(Number.isInteger(pri) && pri >= 0 && pri <= 3)) throw new Error('pri must be an integer 0-3');
    const out = { title: clip(title.trim(), 120), text: clip(text.trim(), 4000), tags: [...new Set(tags.map((t) => t.trim().toLowerCase()))], source: source === undefined ? undefined : String(source) };
    if (kind !== undefined) out.kind = kind;
    if (scope !== undefined) out.scope = clip(String(scope).trim(), 40);
    if (pri !== undefined) out.pri = pri;
    if (keyless) out.keyless = true;
    if (pri === 3 && !out.tags.includes('core')) out.tags.push('core');
    return out;
  };
  // Raw notes, including vectors (internal use only).
  const all = () => {
    const out = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const note = read(name.slice(0, -5));
        if (note) out.push(note);
      } catch {}
    }
    return out.sort((a, b) => b.updated - a.updated);
  };
  const rank = (notes, q, qv, { tags, limit }) => {
    const inScope = (n) => !Array.isArray(tags) || n.tags.includes('core') || n.tags.some((t) => tags.includes(t));
    const core = notes.filter((n) => n.tags.includes('core') && inScope(n));
    const scored = notes.map(n => ({ n, kw: score(n, q) }));
    const maxKw = scored.reduce((max, x) => Math.max(max, x.kw), 1);
    const sourceCounts = new Map();
    const rest = distinctNotes(scored
      .filter(({ n }) => !n.tags.includes('core') && inScope(n))
      .map(({ n, kw }) => {
        const cos = qv && n.vec && n.vmodel === embedder?.model ? cosine(qv, n.vec) : 0;
        return { n, kw, cos, s: 0.4 * (kw / maxKw) + 0.6 * Math.max(0, cos) };
      })
      .filter((x) => x.kw > 0 || x.cos >= SEMANTIC_MIN)
      .sort((a, b) => b.s - a.s)
      .map(x => x.n))
      // Keep a long transcript from crowding out all other sources.
      .filter(n => {
        const source = n.source?.split(':').slice(0, 2).join(':');
        const previous = sourceCounts.get(source) ?? 0;
        sourceCounts.set(source, previous + 1);
        return !n.tags.includes('episode') || previous < 3;
      })
      .slice(0, limit);
    return [...core, ...rest];
  };
  const toRecord = (n) => mcl.normalize({ scope: n.scope, kind: n.kind ?? 'fact', key: n.keyless ? '' : n.title, val: n.text, tags: n.tags.filter((t) => t !== 'core'), pri: n.tags.includes('core') ? 3 : (n.pri ?? 0), date: mcl.dateCode(n.updated ?? 0), refs: n.source ? [n.source] : [] });
  const srcOf = (r) => `mcl:${r.scope}/${r.key ? r.key.toLowerCase() : mcl.shortHash(r)}`;
  // Fits more retrieved records into a small budget without touching stored notes: exact duplicates are dropped, then the
  // relevant records are shrunk to query-focused extracts at the largest per-record size where every one still fits.
  const SIZES = [Infinity, 600, 320, 180, 100];
  const fitRelevant = (relevant, qwords, room, legend) => {
    const uniq = distinctNotes(relevant);
    let out = '';
    for (const size of SIZES) {
      const recs = uniq.map((n) => {
        const r = toRecord(n);
        if (n.tags.includes('episode') && r.key.includes(' / ')) r.key = r.key.split(' / ').pop().slice(0, 40); // the conversation title repeats on every excerpt
        if (n.tags.includes('episode')) r.tags = r.tags.filter((t) => t !== 'episode' && t !== r.scope); // scope already says chat/task
        const shown = size === Infinity || r.val.length <= size ? r : { ...r, val: focus(r.val, qwords, size) };
        return { ...shown, val: (n.tags.includes("episode") ? currency(n.text) : "") + shown.val };
      });
      out = mcl.render(recs, { maxChars: room, legend, order: sourceOrder });
      if (!out.includes('# +') || !/# \+\d+ more$/.test(out)) break;
    }
    return out;
  };
  const render = (picked, maxChars, format, query = '') => {
    if (format === 'mcl') {
      const core = picked.filter(n => n.tags.includes('core'));
      const relevant = picked.filter(n => !n.tags.includes('core'));
      const head = fitRelevant(core, [], relevant.length ? Math.floor(maxChars * 0.55) : maxChars, true);
      const tail = fitRelevant(relevant, words(query), maxChars - head.length - (head ? 3 : 0), !head);
      return head && tail ? `${head}
@
${tail}` : head || tail;
    }
    const lines = [];
    let used = 0;
    for (const n of picked) {
      const line = `- ${n.title}: ${n.text.replace(/\s+/g, ' ')}`;
      if (used + line.length > maxChars) continue;
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
      sourceIndex ??= new Map(all().filter(n => n.source).map(n => [n.source, n.id]));
      const existing = c.source && sourceIndex.has(c.source) ? read(sourceIndex.get(c.source)) : null;
      if (existing) { const { vec, vmodel, ...rest } = existing; return publicNote(write({ ...rest, ...c, updated: now() })); } // vector is stale after an upsert
      const t = now();
      const note = write({ id: newId(), ...c, created: t, updated: t });
      if (c.source) sourceIndex.set(c.source, note.id);
      return publicNote(note);
    },
    update(id, fields) {
      const n = read(id);
      if (!n) throw new Error('Memory note not found');
      // Text or tag changes make the stored vector stale; it is recomputed on the next semantic search.
      const { vec, vmodel, ...rest } = n;
      const c = clean({ ...rest, ...fields });
      if (sourceIndex && n.source !== c.source) {
        sourceIndex.delete(n.source);
        if (c.source) sourceIndex.set(c.source, id);
      }
      const changed = c.title !== n.title || c.text !== n.text || c.tags.join() !== n.tags.join();
      return publicNote(write({ ...rest, ...c, updated: now(), ...(changed ? {} : { vec, vmodel }) }));
    },
    remove(id) {
      const note = read(id);
      if (!note) throw new Error('Memory note not found');
      renameSync(file(id), join(trash, `${id}.json`));
      sourceIndex?.delete(note.source);
    },
    search(query, limit = 5) {
      const q = words(query);
      return all().map((n) => ({ n, s: score(n, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => publicNote(x.n));
    },
    // Text for a route's system prompt: always the 'core' notes, plus the best matches for this prompt.
    // tags (array) restricts to notes carrying one of those tags (core notes still apply).
    context(prompt, { tags, maxChars = 1800, limit = 4, format, exclude } = {}) {
      return render(rank(all().filter((n) => !exclude?.includes(n.source)), words(prompt), null, { tags, limit }), maxChars, format, prompt);
    },
    // Semantic version of context(). Falls back to keyword matching if the embedder is missing or fails.
    async contextAsync(prompt, opts = {}) {
      if (!embedder) return store.context(prompt, opts);
      const { tags, maxChars = 1800, limit = 4, format, exclude } = opts;
      let qv = null;
      try {
        qv = await queryVector(prompt);
        await indexMissing();
      } catch {
        return store.context(prompt, opts);
      }
      return render(rank(all().filter((n) => !exclude?.includes(n.source)), words(prompt), qv, { tags, limit }), maxChars, format, prompt);
    },
    // Computes vectors for notes that have none (or were made with another model). Returns how many were embedded.
    async indexMissing() {
      if (!embedder) return 0;
      return indexMissing();
    },
    exists: () => existsSync(dir),
    // The whole memory as MCL text (alias-packed unless alias:false), plus size stats.
    exportMcl({ alias = true } = {}) {
      const records = all().map(toRecord);
      return { text: mcl.serialize(records, { alias }), stats: mcl.stats(records) };
    },
    // Apply MCL text (e.g. written by a local model): upserts notes by scope+key, '-' lines trash the matching note.
    importMcl(text) {
      const { records, errors } = mcl.parse(text);
      let added = 0, updated = 0, retired = 0;
      for (const r of records) {
        const source = srcOf(r);
        const existing = all().find((n) => n.source === source || (r.key && (n.scope ?? '') === r.scope && n.title.toLowerCase() === r.key.toLowerCase()));
        if (r.kind === 'retire') {
          if (existing) (store.remove(existing.id), retired++);
          continue;
        }
        const tags = r.pri >= 3 ? [...r.tags, 'core'] : r.tags;
        const fields = { title: r.key || r.val.slice(0, 80), text: r.val || r.key, tags, source, kind: r.kind, scope: r.scope, pri: r.pri, keyless: !r.key };
        existing ? store.update(existing.id, fields) : store.add(fields);
        existing ? updated++ : added++;
      }
      return { added, updated, retired, errors };
    },
  };

  const queryCache = new Map();
  async function queryVector(prompt) {
    const key = `${embedder.model}:${prompt}`;
    if (queryCache.has(key)) return queryCache.get(key);
    const [v] = await embedder.embed([prompt]);
    queryCache.set(key, v);
    if (queryCache.size > 32) queryCache.delete(queryCache.keys().next().value);
    return v;
  }
  let indexing;
  async function indexMissing() {
    if (indexing) return indexing;
    indexing = doIndex().finally(() => { indexing = null; });
    return indexing;
  }
  async function doIndex() {
    const todo = all().filter((n) => !(n.vec && n.vmodel === embedder.model));
    if (!todo.length) return 0;
    // Bound foreground work; later queries progressively finish the index.
    const batch = todo.slice(0, 32);
    const vectors = await embedder.embed(batch.map(textFor));
    let count = 0;
    batch.forEach((n, i) => {
      const current = read(n.id);
      // An edit/delete while Ollama was working must never be overwritten/resurrected.
      if (current && textFor(current) === textFor(n) && Array.isArray(vectors[i]) && vectors[i].length && vectors[i].every(Number.isFinite)) {
        write({ ...current, vec: vectors[i], vmodel: embedder.model }); count++;
      }
    });
    return count;
  }

  return store;
}
