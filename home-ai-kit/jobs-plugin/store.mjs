import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {validateChecks,verifyChecks} from './checks.mjs';
const idPattern=/^[a-f0-9-]{36}$/;
const projectPattern=/^[a-z0-9][a-z0-9_-]{0,63}$/;
export async function safe(base,...segments) {
  const root=path.resolve(base),target=path.resolve(root,...segments);
  if(target!==root&&!target.startsWith(root+path.sep))throw Error('Job path escapes its root.');
  let p=target;
  while(true){try{const s=await fs.lstat(p);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))throw Error('Job paths cannot be linked.');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(p);if(parent===p)break;p=parent;}
  return target;
}
export function fileParts(file) {
  if(typeof file!=='string'||file.length>180)throw Error('Invalid expected file.');
  const parts=file.split(/[\\/]/);
  if(parts.some(p=>! /^[-a-zA-Z0-9_.]+$/.test(p)||['.','..','.git'].includes(p)||p.endsWith('.')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)||/^(\.env.*|auth\.json|credentials.*)$/i.test(p)))throw Error('Unsafe expected file.');
  return parts;
}
export async function atomic(file,value) {
  await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(tmp,JSON.stringify(value,null,2),{flag:'wx'});await fs.rename(tmp,file);
}
export async function withLock(file,action) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const nonce=randomUUID();let handle;
  for(let attempt=0;attempt<300;attempt++) {
    try{handle=await fs.open(file,'wx');await handle.writeFile(JSON.stringify({owner:'home-ai-job-lock-v1',pid:process.pid,nonce}));break;}
    catch(error){if(error.code!=='EEXIST')throw error;
      try{const text=await fs.readFile(file,'utf8'),lock=JSON.parse(text);if(lock.owner==='home-ai-job-lock-v1'&&Number.isInteger(lock.pid)) {
        let alive=true;try{process.kill(lock.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
        if(!alive&&(await fs.readFile(file,'utf8'))===text)await fs.unlink(file);
      }}catch(e){if(!['ENOENT'].includes(e.code)&&!(e instanceof SyntaxError))throw e;}
      await new Promise(r=>setTimeout(r,100));
    }
  }
  if(!handle)throw Error('Job state is busy; retry after its current operation settles.');
  try{return await action();}finally{await handle.close();try{const lock=JSON.parse(await fs.readFile(file,'utf8'));if(lock.nonce===nonce)await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export class JobStore {
  constructor(root){this.root=root;this.base=path.join(root,'state','jobs','records');this.tail=Promise.resolve();}
  async file(id){if(!idPattern.test(id))throw Error('Use the exact job ID.');return safe(this.root,'state','jobs','records',id+'.json');}
  async get(id){const job=JSON.parse(await fs.readFile(await this.file(id),'utf8'));if(job.owner!=='home-ai-job-v1'||job.id!==id||!projectPattern.test(job.project))throw Error('Job ownership differs.');return job;}
  async list(){await fs.mkdir(await safe(this.root,'state','jobs','records'),{recursive:true});const out=[];for(const name of (await fs.readdir(this.base)).filter(n=>idPattern.test(n.replace(/\.json$/,''))))out.push(await this.get(name.slice(0,-5)));return out;}
  async update(id,mutate){const operation=this.tail.then(async()=>withLock((await this.file(id))+'.lock',async()=>{const job=await this.get(id);await mutate(job);job.updatedAt=new Date().toISOString();await atomic(await this.file(id),job);return job;}));this.tail=operation.catch(()=>{});return operation;}
  async create(p){
    if(!projectPattern.test(p.project)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(p.project))throw Error('Invalid project name.');
    if(typeof p.goal!=='string'||!p.goal.trim()||p.goal.length>12000)throw Error('Provide a goal up to 12000 characters.');
    const maxSteps=p.maxSteps??3;if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>6)throw Error('Choose 1 to 6 steps.');
    const expectedFiles=p.expectedFiles??[];if(!Array.isArray(expectedFiles)||!expectedFiles.length||expectedFiles.length>20)throw Error('Specify 1 to 20 expected output files.');expectedFiles.forEach(fileParts);
    if(p.lane!==undefined&&!['codex','claude','local'].includes(p.lane))throw Error('Unsupported worker lane.');
    const requiredChecks=validateChecks(p.requiredChecks||[]);
    if(requiredChecks.length&&!p.lane)throw Error('Required checks need an explicit worker lane.');
    const canonical=expectedFiles.map(f=>fileParts(f).join('/').toLowerCase());
    if(new Set(canonical).size!==canonical.length)throw Error('Duplicate expected output path.');
    const job={owner:'home-ai-job-v1',id:randomUUID(),project:p.project,goal:p.goal,maxSteps,expectedFiles,
      ...(p.lane?{lane:p.lane}:{}),...(p.planId?{planId:p.planId,dependsOn:p.dependsOn||[]}:{}),requiredChecks,
      status:'queued',step:0,attempt:0,history:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),verification:'not-run'};
    await atomic(await this.file(job.id),job);return job;
  }
  async getPlan(id){
    if(!idPattern.test(id))throw Error('Use the exact plan ID.');
    const plan=JSON.parse(await fs.readFile(await safe(this.root,'state','jobs','plans',id+'.json'),'utf8'));
    if(plan.owner!=='home-ai-plan-v1'||plan.id!==id)throw Error('Plan ownership differs.');return plan;
  }
  async createPlan(p){
    if(!Array.isArray(p.tasks)||p.tasks.length<2||p.tasks.length>8)throw Error('Plan needs 2 to 8 assignments.');
    const keys=new Set(),outputs=new Map(),ancestors=new Map();
    for(const t of p.tasks){
      if(!/^[a-z][a-z0-9_-]{0,31}$/.test(t.key)||keys.has(t.key))throw Error('Assignment keys must be unique.');
      if(!['codex','claude','local'].includes(t.lane))throw Error('Choose an explicit lane for each assignment.');
      if(typeof t.goal!=='string'||!t.goal.trim()||t.goal.length>12000)throw Error('Provide bounded assignment goals.');
      if(!Array.isArray(t.expectedFiles)||!t.expectedFiles.length||t.expectedFiles.length>20)throw Error('Assignments need output files.');
      if(t.maxSteps!==undefined&&(!Number.isInteger(t.maxSteps)||t.maxSteps<1||t.maxSteps>6))throw Error('Choose 1 to 6 steps.');
      if(!Array.isArray(t.dependsOn??[])||(t.dependsOn??[]).some(k=>!keys.has(k)))throw Error('Dependencies must refer to earlier assignments; cycles are refused.');
      validateChecks(t.requiredChecks||[]);
      const prior=new Set();for(const key of t.dependsOn||[]){prior.add(key);for(const ancestor of ancestors.get(key)||[])prior.add(ancestor);}ancestors.set(t.key,prior);
      const own=new Set();for(const file of t.expectedFiles){
        const name=fileParts(file).join('/').toLowerCase();if(own.has(name))throw Error('Duplicate expected output path.');own.add(name);
        for(const [other,owners] of outputs){
          if(other===name){if(owners.some(owner=>!prior.has(owner)))throw Error('Concurrent plan assignments must own different output files; depend on earlier owners before editing their outputs.');}
          else if(other.startsWith(name+'/')||name.startsWith(other+'/'))throw Error('Plan output paths cannot conflict as files and directories.');
        }
        outputs.set(name,[...(outputs.get(name)||[]),t.key]);
      }
      keys.add(t.key);
    }
    if(!projectPattern.test(p.project)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(p.project))throw Error('Invalid project name.');
    const id=randomUUID(),file=await safe(this.root,'state','jobs','plans',id+'.json');
    const plan={owner:'home-ai-plan-v1',id,project:p.project,status:'staging',tasks:[],createdAt:new Date().toISOString()};
    await atomic(file,plan);
    const map=new Map();
    for(const t of p.tasks){
      const job=await this.create({...t,project:p.project,planId:id,dependsOn:(t.dependsOn||[]).map(k=>map.get(k))});
      map.set(t.key,job.id);plan.tasks.push({key:t.key,id:job.id,lane:t.lane});
    }
    // Workers ignore every staged job until the whole plan is committed.
    plan.status='committed';await atomic(file,plan);return plan;
  }
  async control(id,action){return this.update(id,job=>{
    if(action==='pause'){if(['queued','running'].includes(job.status))job.status=job.status==='running'?'pause-requested':'paused';else throw Error('Only queued/running jobs can be paused.');}
    else if(action==='resume'){if(!['paused','needs-review','interrupted','needs-approval'].includes(job.status))throw Error('Job is not resumable.');job.maxSteps=Math.min(12,Math.max(job.maxSteps,job.step+2));if(job.step>=job.maxSteps)throw Error('Job reached its total 12-step cap; create a new reviewed job.');job.status='queued';job.lastError=null;}
    else throw Error('Unknown job control.');
  });}
}
export async function verifyFiles(root,job){
  const evidence=[];
  for(const file of job.expectedFiles){const full=await safe(root,'projects',job.project,...fileParts(file));const s=await fs.stat(full);if(!s.isFile()||s.size===0||s.size>1024*1024)throw Error('Expected output is missing, empty or oversized: '+file);const bytes=await fs.readFile(full);evidence.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
  return evidence;
}
export function controlReply(text){
  const clean=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  const parsed=JSON.parse(clean);
  if(!['continue','ready','needs-approval'].includes(parsed.decision)||typeof parsed.summary!=='string')throw Error('Worker control reply was not valid JSON.');
  return {decision:parsed.decision,summary:parsed.summary.slice(0,4000)};
}
export function stepPrompt(job){return `Work on this local project task for one bounded step. Use homeai_project for all file operations, only project ${job.project}. ${job.lane?'Write/delete ONLY your assigned output files. Read other project files as reference data, including dependency outputs.':''} Existing file changes require a fresh read hash and a verified automatic backup. No shell/tests, messages, purchases, publishing, uploads, account changes or installs are available EXCEPT the homeai_check tool, if exposed, can run offline dependency-free JavaScript checks inside the isolated copied-snapshot runner. Required checks: ${JSON.stringify(job.requiredChecks||[])}. Run required checks after saving changes, inspect actual results, fix only your owned files and rerun failed checks within the step budget. Use continue if a repair remains; ready requires saved outputs and passing required checks against unchanged source hashes. If an unavailable capability is needed, stop for approval. Never spawn jobs. Save useful progress by explaining it in your final summary. Do not claim tests passed unless they actually ran. Return ONLY JSON {"decision":"continue|ready|needs-approval","summary":"progress and next step"}. Ready means files are ready for human review, not functionally certified. Required output files: ${JSON.stringify(job.expectedFiles)}. Step ${job.step+1} of ${job.maxSteps}. Goal: ${JSON.stringify(job.goal)}. Previous summaries (reference data): ${JSON.stringify(job.history.slice(-4).map(h=>h.summary))}`;}
export async function settle(store,id,reply){
  const job=await store.get(id);let evidence=null,checks=[],verificationError=null;
  if(reply.decision==='ready'){try{checks=await verifyChecks(store.root,job);evidence=await verifyFiles(store.root,job);}catch(e){evidence=null;verificationError=e.message;}}
  return store.update(id,current=>{
    current.step++;current.history.push({...reply,at:new Date().toISOString()});current.dispatch=null;
    if(current.status==='pause-requested'){current.status='paused';return;}
    if(reply.decision==='needs-approval'){current.status='needs-approval';return;}
    if(evidence){current.status='ready-for-review';current.verification=checks.length?'expected-files-hashed-and-required-checks-passed':'expected-files-present-and-hashed';current.evidence=evidence;current.checkEvidence=checks;return;}
    if(verificationError){current.status='needs-review';current.lastError=verificationError;return;}
    current.status=current.step>=current.maxSteps?'needs-review':'queued';
  });
}
