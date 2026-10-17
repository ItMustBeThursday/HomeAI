// MCL - Memory Compact Language. A tiny line-based notation for durable memory that is cheap to store,
// cheap to put in a prompt, and simple enough for small local models to read AND write.
// Full spec: MEMORY-LANGUAGE.md.  One record per line:
//
//   @adam                      scope header (applies to the lines below it; "@" alone = no scope)
//   !never touch OneDrive;^3   sigil + body [; modifiers]
//   =pc:7900XT 20GB, 64GB RAM;#hw '261016
//
// Sigils: ! rule  = fact (key:value)  ~ preference  > todo  + done/verified  ? open/unverified  - retire (tombstone)
// Modifiers (after the first unescaped ';'): #tag  ^0-3 priority (3 = always include)  'YYMMDD date  &ref
// Escapes: \\ \n \; \: \$   Aliases: "$a=orchestrator" lines let pack() shorten repeated words to "$a".
// The parser is lenient (models write this): bad lines are reported in `errors`, never thrown.
import { createHash } from 'node:crypto';

export const KINDS = { '!': 'rule', '=': 'fact', '~': 'pref', '>': 'todo', '+': 'done', '?': 'open', '-': 'retire' };
export const SIGILS = Object.fromEntries(Object.entries(KINDS).map(([s, k]) => [k, s]));
export const LEGEND = "MCL: !rule =fact(key:val) ~pref >todo +done ?open -retired @scope; suffix ;#tag ^0-3 priority 'YYMMDD date &ref; $x=alias";
const ALIAS_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const ESC = { '\\': '\\\\', '\n': '\\n', '\r': '', ';': '\\;', $: '\\$' };
const esc = (s, extra = '') => String(s).replace(/[\\\n\r;$]/g, (c) => ESC[c]).replace(extra ? new RegExp(`[${extra}]`, 'g') : /(?!)/g, (c) => `\\${c}`);
const tagOk = (t) => String(t).trim().toLowerCase().replace(/[\s;#^'&\\]+/g, '-').replace(/^-+|-+$/g, '');
export const dateCode = (ms) => new Date(ms).toISOString().slice(2, 10).replace(/-/g, '');

// Index of the first unescaped `ch` in s, or -1.
function indexOfRaw(s, ch) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === ch) return i;
  }
  return -1;
}
// Undo escapes and expand $x aliases in one pass.
function unesc(s, aliases) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i];
      out += n === 'n' ? '\n' : n;
    } else if (c === '$' && aliases && Object.hasOwn(aliases, s[i + 1] ?? '')) out += aliases[s[++i]];
    else out += c;
  }
  return out;
}

export function normalize(rec) {
  const tags = [...new Set((rec.tags ?? []).map(tagOk).filter(Boolean))];
  const pri = Math.max(0, Math.min(3, Number.isFinite(+rec.pri) ? Math.trunc(+rec.pri) : 0));
  return {
    scope: String(rec.scope ?? '').trim().replace(/\s+/g, '-'),
    kind: Object.hasOwn(SIGILS, rec.kind) ? rec.kind : 'fact',
    key: String(rec.key ?? '').trim(),
    val: String(rec.val ?? '').trim(),
    tags,
    pri,
    date: /^\d{6}$/.test(rec.date ?? '') ? rec.date : '',
    refs: [...new Set((rec.refs ?? []).map((r) => String(r).trim().replace(/\s+/g, '-')).filter(Boolean))],
  };
}

// Identity used by merge(): same scope + key (or same text when there is no key) means the same memory.
export const recordId = (r) => `${r.scope}\u0000${r.key ? r.key.toLowerCase() : r.val.toLowerCase().replace(/\s+/g, ' ')}`;
export const shortHash = (r) => createHash('sha1').update(recordId(r)).digest('hex').slice(0, 8);

export function parse(text) {
  const records = [];
  const aliases = {};
  const errors = [];
  let scope = '';
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line[0] === '#') return;
    const sig = line[0];
    const rest = line.slice(1);
    if (sig === '@') {
      scope = rest.trim().replace(/\s+/g, '-');
      return;
    }
    if (sig === '$') {
      const m = /^([A-Za-z0-9])=(.*)$/.exec(rest);
      if (m) aliases[m[1]] = unesc(m[2]);
      else errors.push({ line: i + 1, error: 'bad alias' });
      return;
    }
    if (!Object.hasOwn(KINDS, sig)) {
      errors.push({ line: i + 1, error: `unknown sigil "${sig}"` });
      return;
    }
    const semi = indexOfRaw(rest, ';');
    const body = semi < 0 ? rest : rest.slice(0, semi);
    const mods = semi < 0 ? '' : rest.slice(semi + 1);
    const colon = sig === '-' ? -1 : indexOfRaw(body, ':');
    const rec = { scope, kind: KINDS[sig], key: '', val: '', tags: [], pri: 0, date: '', refs: [] };
    if (colon >= 0) {
      rec.key = unesc(body.slice(0, colon), aliases);
      rec.val = unesc(body.slice(colon + 1), aliases);
    } else if (sig === '-') rec.key = unesc(body, aliases);
    else rec.val = unesc(body, aliases);
    for (const m of mods.split(/\s+/).filter(Boolean)) {
      if (m[0] === '#') rec.tags.push(m.slice(1));
      else if (m[0] === '^') rec.pri = Number(m.slice(1)) || 0;
      else if (m[0] === "'") rec.date = m.slice(1);
      else if (m[0] === '&') rec.refs.push(m.slice(1));
    }
    const n = normalize(rec);
    if (!n.key && !n.val) errors.push({ line: i + 1, error: 'empty record' });
    else records.push(n);
  });
  return { records, aliases, errors };
}

function line(r, enc) {
  const body = r.kind === 'retire' ? enc(r.key || r.val, ':') : r.key ? `${enc(r.key, ':')}:${enc(r.val)}` : enc(r.val, ':');
  const mods = [...r.tags.map((t) => `#${t}`), r.pri ? `^${r.pri}` : '', r.date ? `'${r.date}` : '', ...r.refs.map((x) => `&${x}`)].filter(Boolean).join(' ');
  return `${SIGILS[r.kind]}${body}${mods ? `;${mods}` : ''}`;
}

// Walk the words of an already-escaped string (skipping escape pairs) calling fn(word) -> replacement.
function mapWords(s, fn) {
  let out = '';
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\\') {
      out += s.slice(i, i + 2);
      i += 2;
    } else if (/[A-Za-z0-9_]/.test(s[i]) && !(i > 0 && s[i - 1] === '$')) {
      let j = i;
      while (j < s.length && (/[A-Za-z0-9_]/.test(s[j]) || (s[j] === '-' && /[A-Za-z0-9_]/.test(s[j + 1] ?? '')))) j++;
      out += fn(s.slice(i, j));
      i = j;
    } else out += s[i++];
  }
  return out;
}

function learnAliases(records, max = 62) {
  const counts = new Map();
  for (const r of records) for (const f of [r.key, r.val]) mapWords(esc(f), (w) => (w.length >= 5 && counts.set(w, (counts.get(w) ?? 0) + 1), w));
  const ranked = [...counts]
    .map(([w, c]) => ({ w, gain: c * (w.length - 2) - (w.length + 5) }))
    .filter((x) => x.gain > 0)
    .sort((a, b) => b.gain - a.gain || a.w.localeCompare(b.w))
    .slice(0, Math.min(max, ALIAS_CHARS.length));
  return Object.fromEntries(ranked.map((x, i) => [x.w, ALIAS_CHARS[i]]));
}

// records -> MCL text. alias:true learns a word dictionary (best for storage); false is plain (best for prompts).
export function serialize(records, { alias = false, legend = false } = {}) {
  const recs = records.map(normalize);
  const dict = alias ? learnAliases(recs) : {};
  const enc = (s, extra) => mapWords(esc(s, extra), (w) => (Object.hasOwn(dict, w) ? `$${dict[w]}` : w));
  const groups = new Map([['', []]]);
  for (const r of recs) (groups.get(r.scope) ?? groups.set(r.scope, []).get(r.scope)).push(r);
  const out = [];
  if (legend) out.push(`# ${LEGEND}`);
  for (const [w, c] of Object.entries(dict)) out.push(`$${c}=${esc(w)}`);
  for (const [scope, rs] of groups) {
    if (!rs.length) continue;
    if (scope || out.some((l) => l[0] === '@')) out.push(`@${scope}`);
    for (const r of rs) out.push(line(r, enc));
  }
  return out.join('\n');
}

// Apply incoming records to a base set: upsert by identity, '-' retires. Pure; returns the new array.
export function merge(base, incoming) {
  const map = new Map(base.map(normalize).map((r) => [recordId(r), r]));
  for (const r of incoming.map(normalize)) {
    if (r.kind === 'retire') map.delete(recordId({ ...r, val: r.key ? '' : r.val }));
    else map.set(recordId(r), r);
  }
  return [...map.values()];
}

// Rank records for a query: priority first, rules next, then word overlap, then recency.
export function select(records, query = '', { limit = 20 } = {}) {
  const q = new Set((String(query).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
  return records
    .map(normalize)
    .filter((r) => r.kind !== 'retire')
    .map((r) => {
      const hay = new Set((`${r.scope} ${r.key} ${r.val} ${r.tags.join(' ')}`.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
      let hits = 0;
      for (const w of q) if (hay.has(w)) hits++;
      return { r, s: r.pri * 100 + (r.kind === 'rule' ? 20 : 0) + hits * 10 + (r.date ? Number(r.date) / 1e7 : 0), hits };
    })
    .filter((x) => x.r.pri >= 3 || x.hits > 0 || x.r.kind === 'rule')
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}

// Prompt-ready block within a character budget; records are taken in the order given (callers rank first).
export function render(records, { maxChars = 1800, legend = true, alias = false, order = (rs) => rs } = {}) {
  const head = legend ? `# ${LEGEND}\n` : '';
  const kept = [];
  let omitted = 0;
  const footerRoom = `\n# +${records.length} more`.length;
  for (const r of records.map(normalize).filter((x) => x.kind !== 'retire')) {
    const next = [...kept, r];
    if (head.length + serialize(next, { alias }).length + footerRoom > maxChars) omitted++;
    else kept.push(r);
  }
  if (!kept.length) return '';
  return `${head}${serialize(order(kept), { alias })}${omitted ? `\n# +${omitted} more` : ''}`;
}

// Size comparison against the verbose JSON form, for reporting.
export function stats(records) {
  const json = JSON.stringify(records.map(normalize)).length;
  const plain = serialize(records).length;
  const packed = serialize(records, { alias: true }).length;
  return { records: records.length, json, plain, packed, ratio: json ? +(packed / json).toFixed(3) : 0, approxTokens: { json: Math.ceil(json / 4), packed: Math.ceil(packed / 4) } };
}
