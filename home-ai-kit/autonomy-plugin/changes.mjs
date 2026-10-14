import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {withFileLock} from './lock.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function safe(root,...parts){const base=path.resolve(root),full=path.resolve(base,...parts);if(full!==base&&!full.startsWith(base+path.sep))throw Error('Managed change path escapes its root.');let p=full;while(true){try{const s=await fs.lstat(p);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))throw Error('Managed changes refuse links.');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(p);if(parent===p)break;p=parent;}return full;}
export async function atomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(value,null,2),{flag:'wx'});await fs.rename(temp,file);}
export async function settings(root){const data=JSON.parse(await fs.readFile(await safe(root,'homeai.json'),'utf8'));if(data.owner!=='home-ai-kit-v1'||path.resolve(data.root)!==path.resolve(root))throw Error('HomeAI ownership differs.');return data;}
const slots={guidance:['state','router','guidance.txt'],pool:['state','router','pool.json']};
export async function readSlot(root,slot){if(!slots[slot])throw Error('Unknown managed slot.');const file=await safe(root,...slots[slot]);const bytes=await fs.readFile(file);if(bytes.length>128*1024)throw Error('Managed slot is oversized.');return {slot,text:bytes.toString('utf8'),sha256:hash(bytes)};}
export async function change(root,slot,text,expectedSha256,reason,actor='system'){
  if(!slots[slot]||typeof text!=='string'||Buffer.byteLength(text)>128*1024||typeof reason!=='string'||!reason.trim()||reason.length>1000)throw Error('Bounded managed content and change reason required.');
  if(slot==='guidance'&&Buffer.byteLength(text)>8000)throw Error('Managed task guidance is limited to 8000 bytes.');
  if(slot==='pool'){const value=JSON.parse(text);if(value.owner!=='home-ai-router-v1'||!Array.isArray(value.models))throw Error('Pool ownership differs.');}
  return withFileLock(await safe(root,'state','router','change.lock'),async()=>{
    const prior=await readSlot(root,slot);if(prior.sha256!==expectedSha256)throw Error('Managed slot changed; read it again before editing.');
    const data=await settings(root),id=randomUUID(),backup=await safe(data.backupRoot,'router-changes',id,'before.bin');await fs.mkdir(path.dirname(backup),{recursive:true});
    await fs.writeFile(backup,prior.text,{flag:'wx'});if(hash(await fs.readFile(backup))!==prior.sha256)throw Error('Managed backup verification failed.');
    const record={owner:'home-ai-change-v1',id,slot,beforeSha256:prior.sha256,afterSha256:hash(Buffer.from(text)),reason,actor,at:new Date().toISOString(),backup,verifiedBackup:true,status:'prepared'};
    const journal=await safe(root,'state','router','changes',id+'.json');await atomic(journal,record);
    if((await readSlot(root,slot)).sha256!==prior.sha256)throw Error('Managed source changed during backup.');
    const file=await safe(root,...slots[slot]),temp=file+'.'+id+'.tmp';await fs.writeFile(temp,text,{flag:'wx'});await fs.rename(temp,file);
    record.status='applied';await atomic(journal,record);return record;
  });
}
export async function listChanges(root){const folder=await safe(root,'state','router','changes');let names=[];try{names=await fs.readdir(folder);}catch(e){if(e.code!=='ENOENT')throw e;}const changes=[];for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){const row=JSON.parse(await fs.readFile(await safe(folder,name),'utf8'));if(row.owner==='home-ai-change-v1')changes.push(row);}return changes.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100);}
export async function restore(root,id){
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Use the exact change ID.');
  const row=JSON.parse(await fs.readFile(await safe(root,'state','router','changes',id+'.json'),'utf8'));if(row.owner!=='home-ai-change-v1'||row.id!==id||!['applied','prepared'].includes(row.status)||!slots[row.slot])throw Error('Change is not restorable.');
  const data=await settings(root),backup=await safe(data.backupRoot,'router-changes',id,'before.bin');
  if(path.resolve(backup)!==path.resolve(row.backup))throw Error('Backup location differs.');
  const bytes=await fs.readFile(backup);if(hash(bytes)!==row.beforeSha256)throw Error('Restore backup hash differs.');
  const current=await readSlot(root,row.slot);if(current.sha256!==row.afterSha256)throw Error('A newer change exists; restore the newest change first.');
  return change(root,row.slot,bytes.toString('utf8'),current.sha256,'Restore managed change '+id,'human-restore');
}
