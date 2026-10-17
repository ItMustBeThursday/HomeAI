// Validates the main MCL memory bank before/after any edit. Usage: node scripts/memory-bank-check.mjs [path]
// Exit 1 on parse errors, duplicate identities, keyless facts, secret-looking text, semicolons that swallowed modifiers,
// or a core (^3) packet bigger than --core-max (default 4500 chars). Prints stats; never prints record text.
import { readFileSync } from 'node:fs';
import * as mcl from '../src/mcl.mjs';

const args = process.argv.slice(2);
const coreMax = Number(args.find((a) => a.startsWith('--core-max='))?.split('=')[1] ?? 4500);
const path = args.find((a) => !a.startsWith('--')) ?? 'D:/HomeAI/workspace/MEMORY.mcl';
const text = readFileSync(path, 'utf8');
const { records, errors } = mcl.parse(text);
const problems = errors.map((e) => `line ${e.line}: ${e.error}`);
const seen = new Map();
for (const r of records) {
  const id = mcl.recordId(r);
  if (seen.has(id)) problems.push(`duplicate identity in scope "${r.scope}": ${(r.key || r.val).slice(0, 40)}`);
  seen.set(id, true);
  if (r.kind === 'fact' && !r.key) problems.push(`fact without key (cannot upsert): ${r.val.slice(0, 40)}`);
  if (/(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY)/.test(`${r.key} ${r.val}`)) problems.push(`secret-looking text in ${r.scope}/${r.key || r.kind}`);
  if (/(^|\s)[#^'&][^\s]*;/.test(r.val) || /\s\^\d|\s#[a-z]/.test(r.val)) problems.push(`modifier text inside body (unescaped ";"?) in ${r.scope}/${r.key || r.val.slice(0, 30)}`);
  if (r.val.length > 700) problems.push(`record too long (${r.val.length}) in ${r.scope}/${r.key}`);
}
const core = records.filter((r) => r.pri >= 3);
const coreChars = mcl.render(core, { maxChars: 1e6, legend: true }).length;
if (coreChars > coreMax) problems.push(`core (^3) packet ${coreChars} chars exceeds ${coreMax}: demote some ^3 rules`);
const scopes = {};
for (const r of records) scopes[r.scope || '-'] = (scopes[r.scope || '-'] ?? 0) + 1;
console.log(JSON.stringify({ path, records: records.length, scopes, coreRecords: core.length, coreChars, stats: mcl.stats(records), problems: problems.length }));
for (const p of problems) console.log(`PROBLEM ${p}`);
process.exit(problems.length ? 1 : 0);
