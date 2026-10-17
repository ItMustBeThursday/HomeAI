// Deterministic text compression used to fit more context into small models. No model call, no network, pure functions.
//   plain(text)        strip markdown noise, collapse whitespace
//   tele(text)         telegraphic form: plain() plus articles/filler dropped (for stored memory records)
//   gist(text, max)    extractive summary: keeps the sentences that carry facts (numbers, paths, outcomes), in order
// These are lossy by design; callers keep the verbatim text elsewhere (conversation files) and only compress what is
// put into a prompt.
const FILLER = /\b(?:the|a|an|please|just|really|very|basically|actually|simply|kindly|in order to)\b\s*/gi;
const SIGNAL = /\d|[\/][\w.-]+|\b(?:error|fail(?:ed|s|ure)?|verified|unverified|fixed|created|added|removed|decid\w*|must|never|always|todo|done|passed|blocked|because|result|next)\b|`[^`]+`/i;

export function plain(text) {
  return String(text ?? '')
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => `[code ${String(code).trim().split('\n').length}l] `)
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, '')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function tele(text) {
  return plain(text).replace(/\n+/g, '; ').replace(FILLER, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

export function gist(text, max = 240) {
  const t = plain(text);
  if (t.length <= max) return t.replace(/\n+/g, ' ');
  const parts = t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const scored = parts.map((s, i) => ({ s, i, v: (i === 0 ? 3 : 0) + (i === parts.length - 1 ? 1 : 0) + (SIGNAL.test(s) ? 2 : 0) - s.length / 400 }));
  const picked = [];
  let used = 0;
  for (const x of [...scored].sort((a, b) => b.v - a.v)) {
    const room = max - used - (picked.length ? 3 : 0);
    if (room < 20) continue;
    const s = clip(x.s, picked.length ? Math.min(room, 160) : room);
    picked.push({ i: x.i, s });
    used += s.length + (picked.length > 1 ? 3 : 0);
  }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(' / ');
}

// Rough token estimate (about 4 chars per token for English prose/code); used only for budgeting.
export const approxTokens = (s) => Math.ceil(String(s ?? '').length / 4);

// Query-focused extract: keeps the sentences that mention the query words (plus fact-bearing ones), in original order,
// clipped to max. Unlike gist() it favours what the current request asks about. Exact numbers/names inside kept sentences
// survive verbatim. qwords: lowercase words of the query.
export function focus(text, qwords = [], max = 240) {
  const t = plain(text).replace(/\n+/g, ' ');
  if (t.length <= max) return t;
  const q = new Set(qwords);
  const parts = t.split(/(?<=[.!?;])\s+|\s\/\s/).map((s) => s.trim()).filter(Boolean)
    .filter((s, i, a) => a.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i); // repeated sentences carry nothing new
  const scored = parts.map((s, i) => {
    const w = new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    let hits = 0;
    for (const x of q) if (w.has(x)) hits++;
    return { s, i, v: hits * 5 + (SIGNAL.test(s) ? 1 : 0) + (i === 0 ? 0.5 : 0) - s.length / 600 };
  });
  const picked = [];
  let used = 0;
  for (const x of [...scored].sort((a, b) => b.v - a.v)) {
    const room = max - used - (picked.length ? 3 : 0);
    if (room < 20) continue;
    // A sentence that mentions the query keeps more room than a context sentence.
    const s = clip(x.s, x.v >= 5 ? room : Math.min(room, 120));
    picked.push({ i: x.i, s });
    used += s.length + (picked.length > 1 ? 3 : 0);
  }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.s).join(' / ');
}

// Drops near-duplicate texts (word-set Jaccard >= threshold), keeping the first of each group. Returns kept indexes.
export function dedupe(texts, threshold = 0.8) {
  const sets = texts.map((t) => new Set(String(t).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
  const keep = [];
  sets.forEach((a, i) => {
    const dup = keep.some((j) => {
      const b = sets[j];
      if (!a.size || !b.size) return false;
      let inter = 0;
      for (const w of a) if (b.has(w)) inter++;
      return inter / (a.size + b.size - inter) >= threshold;
    });
    if (!dup) keep.push(i);
  });
  return keep;
}

// Distinct meaningful words of a request (stopwords removed), used to find the older chat turns that matter to it.
const QSTOP = new Set('the and for are but not you your with this that have has had was were what when where which who whom how why can could would should will shall from into onto about over under than then them they their there here been being did does done doing just also any all some one two more most such only very out our ours its his her him she him let get got give gave tell told say said please reply answer earlier before again still now new old use used using want need make made like know'.split(' '));
export const queryWords = (text) => [...new Set((String(text ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !QSTOP.has(w)))];
