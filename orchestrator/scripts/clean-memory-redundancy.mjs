// Local-only, reversible migration. Original transcripts remain untouched.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConversationStore } from '../src/history.mjs';
import { excludedConversation } from '../src/memory-policy.mjs';
const root = 'D:/HomeAI/projects/orchestrator', backup = readFileSync('D:/HomeAI/state/memory-dedup-backup.txt','utf8').trim();
const token = readFileSync(join(root,'data/token.txt'),'utf8').trim();
const api = async (path, method='GET') => {
  const r = await fetch(`http://127.0.0.1:18850/api/${path}`, {method,headers:{authorization:`Bearer ${token}`}});
  if(!r.ok) throw new Error(`Local memory API HTTP ${r.status}`);
  return r.json();
};
const {notes} = await api('memory'), conversations = createConversationStore(join(root,'data/conversations'));
const excluded = new Set();
for(const state of ['active','archived']) for(const c of conversations.list(state)) if(excludedConversation(conversations.get(c.id))) excluded.add(c.id);
const turns = new Set(notes.filter(n=>n.source?.startsWith('turn:')).map(n=>n.source.split(':')[1]));
const retiredLegacy = new Set(['migrated:hardware','migrated:rules','migrated:onedrive','migrated:logan','migrated:orchestrator','migrated:codex','migrated:companion','integration:xerj','integration:cli-anything']);
const candidates = notes.flatMap(n=>{
  const [type,id] = (n.source??'').split(':');
  const reason = ['turn','conv'].includes(type) && excluded.has(id) ? 'excluded-room' : type==='conv' && turns.has(id) ? 'redundant-digest' : retiredLegacy.has(n.source) ? 'consolidated-legacy' : '';
  return reason ? [{id:n.id,source:n.source,reason}] : [];
});
const result={before:notes.length,candidates:candidates.length,reasons:{},applied:false};
for(const n of candidates) result.reasons[n.reason]=(result.reasons[n.reason]??0)+1;
if(process.argv.includes('--apply')) {
  const dest=join(backup,'retired-live'); mkdirSync(dest,{recursive:true});
  const hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
  // Verify the complete migration backup before the first deletion.
  for(const n of candidates){const source=join(root,'data/memory',`${n.id}.json`),copy=join(dest,`${n.id}.json`);copyFileSync(source,copy);n.sha256=hash(source);if(hash(copy)!==n.sha256)throw new Error('Backup hash mismatch');}
  writeFileSync(join(backup,`retirement-manifest-${Date.now()}.json`),JSON.stringify(candidates,null,2));
  for(const n of candidates) await api(`memory/${n.id}`,'DELETE');
  const after=await api('memory');
  if(after.notes.some(n=>candidates.some(c=>c.id===n.id)))throw new Error('Retirement verification failed');
  result.after=after.notes.length;result.applied=true;
}
writeFileSync(join(backup,'cleanup-result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
