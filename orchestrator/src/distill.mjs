// Turns prose the owner already maintains (RESUME/USER/SOUL/AGENTS .md) and finished conversations into compact MCL
// memory records, so every model on every route can see the same durable facts at a fraction of the prompt cost.
// Deterministic: no model call. Lossy by design; the source files stay the full record and the prompt says where.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as mcl from './mcl.mjs';
import { tele, gist } from './squeeze.mjs';
import { excludedConversation } from './memory-policy.mjs';

// MEMORY.mcl is the single main memory bank: parsed losslessly (no distillation). The prose files below are legacy inputs
// that are only distilled when named explicitly; DEFAULT_NAMES is what the live service syncs.
export const BANK = 'MEMORY.mcl';
export const DEFAULT_NAMES = [BANK];
export const LEGACY_NAMES = ['RESUME.md', 'STATE.md', 'USER.md', 'SOUL.md', 'MEMORY.md', 'IDENTITY.md', 'AGENTS.md'];
const SCOPES = { 'RESUME.md': 'project', 'USER.md': 'user', 'SOUL.md': 'soul', 'AGENTS.md': 'agents', 'MEMORY.md': 'notes', 'IDENTITY.md': 'identity' };
const LEGEND_KIND = { '!': 'rule', x: 'done', '+': 'done', o: 'open', '?': 'open', '~': 'pref' };
// Only safety-critical rules become always-included (core) records; other rules rank by relevance like facts.
const HARD = /one-?drive|secret|explicit approval|without approval|backup|publish|purchase|external communication/i;
const RULEISH = /\b(always|never|must|require[sd]?|only|prefer)\b/i;
const MAX_VAL = 320;

const sha = (s) => createHash('sha1').update(s).digest('hex');
const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
// Share of the smaller text's words found in the other (0..1); used to skip near-duplicates.
export function similar(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / Math.min(x.size, y.size);
}

function kindFor(text, fallback = 'fact') {
  if (/^never\b|\bmust not\b|^do not\b/i.test(text)) return 'rule';
  if (/^(always|require|explicit|only)\b/i.test(text)) return 'rule';
  if (/^prefer\b|\bprefer(s|red)?\b/i.test(text)) return 'pref';
  return RULEISH.test(text) ? 'rule' : fallback;
}

// name: file name (RESUME.md ...). Returns normalized MCL records (deduplicated within the file).
export function distill(name, text) {
  const scope = SCOPES[name] ?? name.replace(/\.md$/i, '').toLowerCase();
  const out = [];
  const push = (kind, key, body) => {
    const val = gist(tele(body), MAX_VAL);
    if (val.length < 6) return;
    const pri = kind === 'rule' ? (HARD.test(val) ? 3 : 2) : kind === 'open' ? 1 : 0;
    out.push(mcl.normalize({ scope, kind, key, val, pri }));
  };
  const sentences = (s) => s.split(/(?<=[.!?])\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
  for (const raw of String(text ?? '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[-=_*]{3,}$/.test(line)) continue;
    if (/^#{1,6}\s/.test(line) || /^Legend:/i.test(line)) continue;
    const lg = line.match(/^([!xo~+?])\s+(\S.*)$/);
    if (lg) { for (const s of sentences(lg[2])) push(LEGEND_KIND[lg[1]], '', s); continue; }
    const caps = line.match(/^([A-Z][A-Z0-9+ ]{2,}?)\s*[:=]?\s+(\S.*)$/);
    if (caps && caps[1].trim().length >= 3) { push('fact', caps[1].trim().toLowerCase().replace(/\s+/g, '-').slice(0, 30), caps[2]); continue; }
    for (const s of sentences(line.replace(/^[-*]\s+/, ''))) push(kindFor(s), '', s);
  }
  const seen = new Set();
  return out.filter((r) => { const k = `${r.kind}|${r.val.toLowerCase()}`; return seen.has(k) ? false : (seen.add(k), true); });
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// A conversation as one durable record any model can find later by topic. Null when there is no answered exchange yet.
export function conversationFields(conv) {
  if (excludedConversation(conv)) return null;
  const msgs = conv.messages ?? [];
  const users = msgs.filter((m) => m.role === 'user' && m.text);
  const bots = msgs.filter((m) => m.role === 'assistant' && m.text && !m.error);
  if (!users.length || !bots.length) return null;
  const title = clean(conv.title || users[0].text).slice(0, 60);
  const lastAsk = users.length > 1 ? ` | latest ask: ${gist(users.at(-1).text, 120)}` : '';
  // A pasted guide/system prompt as the first message (e.g. the Discord channel rules) is boilerplate: show its tail, where the real request is.
  const first = users[0].text.length > 400 ? `…${clean(users[0].text).slice(-140)}` : gist(users[0].text, 140);
  const val = tele(`asked: ${first}${lastAsk} | outcome: ${gist(bots.at(-1).text, 220)} | ${users.length} turns${conv.project ? `, project ${conv.project}` : ''}`);
  return { title, text: `Model-reported, unverified: ${val}`.slice(0, 700), tags: ['chat'], source: `conv:${conv.id}`, kind: 'open', scope: 'chat', pri: 0 };
}

// Brings memory in line with the workspace notes. The state file remembers each file's content hash, so unchanged files cost nothing.
// Records of a MEMORY.mcl bank, exactly as written (retire tombstones are dropped: removing a line retires its note).
export function bankRecords(text) {
  const { records, errors } = mcl.parse(text);
  return { records: mcl.merge([], records).map((r) => ({ ...r, val: r.val || r.key })), errors };
}

export function syncWorkspace(memory, { dir, names = DEFAULT_NAMES, retireNames = LEGACY_NAMES, stateFile, readText = (p) => readFileSync(p, 'utf8') }) {
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const stats = { files: 0, added: 0, removed: 0, skipped: 0 };
  // Validate the complete bank before touching any stored notes, including legacy retirement.
  // An interrupted/invalid edit must not erase the last usable shared context.
  const bankText = names.includes(BANK) ? readText(`${dir}/${BANK}`) : null;
  if (bankText !== null) {
    const { records, errors } = bankRecords(bankText);
    if (errors.length || !records.length) throw new Error('Memory bank invalid or empty; previous shared memory preserved');
  }
  const own = (n) => /^(ws|conv):/.test(String(n.source ?? ''));
  const curated = memory.list().filter((n) => !own(n));
  // Legacy prose distills (ws:RESUME.md:...) are superseded by the bank; trash them once (restorable in memory/trash).
  for (const legacy of retireNames) {
    if (names.includes(legacy)) continue;
    for (const n of memory.list().filter((x) => String(x.source ?? '').startsWith(`ws:${legacy}:`))) { memory.remove(n.id); stats.removed++; }
  }
  const seenGlobal = new Set();
  const accepted = [];
  for (const name of names) {
    const p = `${dir}/${name}`;
    if (!existsSync(p)) continue;
    const text = name === BANK && bankText !== null ? bankText : readText(p);
    const isBank = name.endsWith('.mcl');
    const hash = sha(`${isBank ? 'bank-v2' : 'distill-v2'}\n${text}`);
    const prefix = `ws:${name}:`;
    const records = isBank ? bankRecords(text).records : distill(name, text);
    if (state[name] === hash) { stats.skipped++; records.forEach((r) => { seenGlobal.add(r.val.toLowerCase()); accepted.push(r.val); }); continue; }
    stats.files++;
    const wanted = new Map();
    for (const r of records) {
      const id = r.val.toLowerCase();
      if (isBank) { wanted.set(`${prefix}${sha(mcl.serialize([r])).slice(0, 10)}`, r); continue; }
      if (seenGlobal.has(id)) continue; // same sentence already taken from another file
      seenGlobal.add(id);
      // Approximate deduplication can erase a correction ("unverified" vs "verified").
      // Only preferences may use containment; outcomes/rules require exact equality.
      if (curated.some((n) => n.text.toLowerCase() === id || (r.kind === 'pref' && [...words(r.val)].every(w => words(n.text).has(w))))) continue;
      if (accepted.some((v) => v.toLowerCase() === id)) continue;
      accepted.push(r.val);
      wanted.set(`${prefix}${sha(`${r.kind}|${r.val}`).slice(0, 10)}`, r);
    }
    const existing = memory.list().filter((n) => String(n.source ?? '').startsWith(prefix));
    for (const n of existing) if (!wanted.has(n.source)) { memory.remove(n.id); stats.removed++; }
    const have = new Set(existing.map((n) => n.source));
    for (const [source, r] of wanted) {
      if (have.has(source)) continue;
      memory.add({ title: r.key || r.val.slice(0, 80), text: r.val, tags: [...(r.pri >= 3 ? ['core', 'ws'] : ['ws']), ...(r.tags ?? [])], source, kind: r.kind, scope: r.scope, pri: r.pri, keyless: !r.key, ...(isBank ? { date: r.date, refs: r.refs } : {}) });
      stats.added++;
    }
    state[name] = hash;
  }
  writeFileSync(stateFile, JSON.stringify(state));
  return stats;
}
