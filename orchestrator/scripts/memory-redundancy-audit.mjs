import { createMemoryStore } from '../src/memory.mjs';
const m = createMemoryStore(new URL('../data/memory', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const notes = m.list(), groups = {};
for (const n of notes) { const k = (n.source || 'manual').split(':')[0]; groups[k] = (groups[k] || 0) + 1; }
const exact = new Map();
for (const n of notes) { const k = JSON.stringify([n.kind, n.scope, n.text.replace(/\s+/g, ' ').trim()]); const a = exact.get(k) || []; a.push(n.id); exact.set(k, a); }
console.log(JSON.stringify({ total: notes.length, groups, exactSurplus: [...exact.values()].reduce((s,a)=>s+a.length-1,0), episodeDuplicates: m.dedupeEpisodes({dryRun:true}).length,
  scaffold: notes.filter(n => /# MCL:|<environment_context>|Retrieved memory is historical|The main memory bank \(MCL\)|^.*[!=?][^\n]*;#(?:ws|rules|safety)/.test(n.text)).length }, null, 2));
