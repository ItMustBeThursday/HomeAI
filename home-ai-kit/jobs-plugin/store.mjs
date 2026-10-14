import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
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
  if(parts.some(p=>! /^[-a-zA-Z0-9_.]+$/.test(p)||['.','..','.git'].includes(p)||p.endsWith('.')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)||/^\.env/i.test(p)))throw Error('Unsafe expected file.');
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
    const job={owner:'home-ai-job-v1',id:randomUUID(),project:p.project,goal:p.goal,maxSteps,expectedFiles,
      status:'queued',step:0,attempt:0,history:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),verification:'not-run'};
    await atomic(await this.file(job.id),job);return job;
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
export function stepPrompt(job){return `Work on this local project task for one bounded step. Use homeai_project for all file operations, only project ${job.project}. Existing file changes require a fresh read hash and a verified automatic backup. No shell/tests, messages, purchases, publishing, uploads, account changes or installs are available. If needed, stop for approval. Never spawn jobs. Save useful progress by explaining it in your final summary. Do not claim tests passed unless they actually ran. Return ONLY JSON {"decision":"continue|ready|needs-approval","summary":"progress and next step"}. Ready means files are ready for human review, not functionally certified. Required output files: ${JSON.stringify(job.expectedFiles)}. Step ${job.step+1} of ${job.maxSteps}. Goal: ${JSON.stringify(job.goal)}. Previous summaries (reference data): ${JSON.stringify(job.history.slice(-4).map(h=>h.summary))}`;}
export async function settle(store,id,reply){
  const job=await store.get(id);let evidence=null,verificationError=null;
  if(reply.decision==='ready'){try{evidence=await verifyFiles(store.root,job);}catch(e){verificationError=e.message;}}
  return store.update(id,current=>{
    current.step++;current.history.push({...reply,at:new Date().toISOString()});current.dispatch=null;
    if(current.status==='pause-requested'){current.status='paused';return;}
    if(reply.decision==='needs-approval'){current.status='needs-approval';return;}
    if(evidence){current.status='ready-for-review';current.verification='expected-files-present-and-hashed';current.evidence=evidence;return;}
    if(verificationError){current.status='needs-review';current.lastError=verificationError;return;}
    current.status=current.step>=current.maxSteps?'needs-review':'queued';
  });
}
