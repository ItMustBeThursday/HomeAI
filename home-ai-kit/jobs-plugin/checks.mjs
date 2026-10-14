import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {safe,fileParts} from './store.mjs';
export function validateChecks(checks=[]){
  if(!Array.isArray(checks)||checks.length>10)throw Error('Choose up to 10 required checks.');
  const keys=new Set();for(const c of checks){if(!['syntax','test'].includes(c.kind)||typeof c.entry!=='string'||! /\.(js|mjs|cjs)$/.test(c.entry))throw Error('Required checks need a JavaScript entry and kind test/syntax.');fileParts(c.entry);const key=c.kind+':'+c.entry;if(keys.has(key))throw Error('Duplicate required check.');keys.add(key);}return checks;
}
export async function verifyChecks(root,job){
  const required=validateChecks(job.requiredChecks||[]);if(!required.length)return [];
  const base=await safe(root,'state','execution','runs');let names=[];try{names=await fs.readdir(base);}catch(e){if(e.code!=='ENOENT')throw e;}
  const reports=[];
  for(const name of names.filter(n=>/^[a-f0-9-]{36}$/.test(n))){try{const report=JSON.parse(await fs.readFile(await safe(base,name,'report.json'),'utf8'));if(report.owner==='home-ai-execution-report-v1'&&report.id===name&&report.project===job.project&&report.jobId===job.id)reports.push(report);}catch(e){if(e.code!=='ENOENT')throw e;}}
  const evidence=[];
  for(const c of required){
    const report=reports.filter(r=>r.kind===c.kind&&r.entry===c.entry).sort((a,b)=>b.finishedAt.localeCompare(a.finishedAt))[0];
    if(!report||report.status!=='passed'||report.exitCode!==0||report.isolation!=='windows-appcontainer-no-capabilities'||c.kind==='test'&&(!(report.tests>0)||!(report.passedTests>0)))throw Error('Required check missing or failed: '+c.kind+' '+c.entry);
    if(!report.sourceHashes?.length||!report.sourceHashes.some(f=>f.file===c.entry))throw Error('Check lacks source evidence.');
    for(const file of report.sourceHashes){const bytes=await fs.readFile(await safe(root,'projects',job.project,...fileParts(file.file)));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Source changed after required check: '+file.file);}
    evidence.push({kind:c.kind,entry:c.entry,runId:report.id,tests:report.tests,passedTests:report.passedTests,finishedAt:report.finishedAt});
  }
  return evidence;
}
