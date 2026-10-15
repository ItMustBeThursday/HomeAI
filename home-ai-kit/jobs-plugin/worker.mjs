import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {JobStore,safe,atomic,withLock,stepPrompt,controlReply,settle} from './store.mjs';
import {agentFor,laneFor,eligible} from './scheduler.mjs';
import {observe,select as selectRoute} from './router.mjs';
import {dispatchBudget} from './dispatch-budget.mjs';
const root=process.argv[2];if(!root)throw Error('Pass HomeAI root.');
const settings=JSON.parse(await fs.readFile(await safe(root,'homeai.json'),'utf8'));
if(settings.owner!=='home-ai-kit-v1'||path.resolve(settings.root)!==path.resolve(root))throw Error('HomeAI ownership differs.');
const budget=dispatchBudget(settings);
const store=new JobStore(root);let stopping=false;const active=new Map(),pending=new Set();
await withLock(await safe(root,'state','jobs','runner.lock'),async()=>{
const stop=()=>{stopping=true;for(const item of active.values())item.child?.kill('SIGTERM');};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
// A previous dispatch may have been accepted. Never automatically replay it.
for(const job of await store.list())if(['running','pause-requested'].includes(job.status))await store.update(job.id,j=>{j.status='interrupted';j.lastError='Gateway/worker stopped during an uncertain dispatch. Inspect its session before explicitly resuming.';});
async function runTurn(job){
  const promptFile=await safe(root,'state','jobs','prompts',job.id+'-'+job.attempt+'.txt');await fs.mkdir(path.dirname(promptFile),{recursive:true});await fs.writeFile(promptFile,stepPrompt(job));
  const claw=await safe(root,'runtime','openclaw','node_modules','openclaw','openclaw.mjs');
  const args=[claw,'agent','--agent',agentFor(job),'--session-key','homeai-job-'+job.id,'--message-file',promptFile,'--timeout',String(budget.agentTimeoutSeconds),'--json'];
  if(stopping)throw Error('Worker stopped before dispatch.');
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',tooLarge=false;
    const processRef=spawn(process.execPath,args,{shell:false,windowsHide:true,cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
    active.get(laneFor(job)).child=processRef;
    const timer=setTimeout(()=>processRef.kill('SIGTERM'),budget.watchdogMs);
    processRef.stdout.on('data',data=>{stdout+=data;if(Buffer.byteLength(stdout)>budget.maxOutputBytes){tooLarge=true;processRef.kill('SIGTERM');}});
    processRef.stderr.on('data',data=>{stderr=(stderr+data).slice(-2000);});
    processRef.on('error',error=>{clearTimeout(timer);reject(error);});
    processRef.on('close',async code=>{
      clearTimeout(timer);
      if(code!==0||tooLarge)return reject(Error('Gateway dispatch did not complete; outcome may be uncertain. Check its native session. '+stderr.slice(-500)));
      try{
        const envelope=JSON.parse(stdout.replace(/^\uFEFF/,''));
        if(envelope.ok===false||envelope.status==='error')throw Error('Gateway returned failure.');
        const payloads=envelope.result?.payloads??envelope.payloads;
        const text=Array.isArray(payloads)?payloads.map(p=>p.text||'').join('\n'):'';
        if(!text)throw Error('Gateway result had no text payload.');
        const outputFile=await safe(root,'state','jobs','results',job.id+'-'+job.attempt+'.json');await atomic(outputFile,envelope);
        const control=controlReply(text);const meta=envelope.result?.meta??envelope.meta;
        control.model=meta?.agentMeta?.model??meta?.model??null;
        control.provider=meta?.agentMeta?.provider??null;
        const usage=meta?.agentMeta?.usage;
        const finite=n=>Number.isFinite(n)&&n>=0?n:null;
        control.tokens=usage?{input:finite(usage.input),output:finite(usage.output),cacheRead:finite(usage.cacheRead),total:finite(usage.total)}:null;
        resolve(control);
      }catch(error){reject(error);}
    });
  });
}
while(!stopping){
  const jobs=(await store.list()).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  for(const savedJob of jobs){
    if(stopping||active.size>=3)break;
    if(savedJob.status!=='queued'||(savedJob.dependsOn||[]).some(id=>jobs.find(j=>j.id===id)?.status!=='ready-for-review'))continue;
    let next=savedJob;
    if(next.status==='queued'&&next.attempt===0&&next.routed){const fresh=await selectRoute(root,{goal:next.goal,role:next.role,lane:next.laneConstraint||undefined,importance:next.importance,busyLanes:[...active.values()].map(v=>laneFor(v.job))});if(fresh)next={...next,lane:fresh.lane,routed:fresh};}
    if(!await eligible(store,next,jobs,[...active.values()].map(v=>v.job)))continue;
    let job;
    try{job=await store.update(next.id,j=>{if(j.status!=='queued')throw Error('Job state changed before dispatch.');if(j.attempt===0&&next.routed){j.routed=next.routed;j.lane=next.lane;}j.status='running';j.attempt++;j.dispatch={at:new Date().toISOString(),agentId:agentFor(j),lane:laneFor(j),sessionKey:'agent:'+agentFor(j)+':homeai-job-'+j.id};});}
    catch(error){if(error.message==='Job state changed before dispatch.')continue;throw error;}
    const lane=laneFor(job);active.set(lane,{job,child:null});
    const task=(async()=>{
      const started=Date.now();
      try{const reply=await runTurn(job);const settled=await settle(store,job.id,reply);await observe(root,settled,reply,Date.now()-started);}
      catch(error){await store.update(job.id,j=>{j.status='interrupted';j.lastError=error.message.slice(0,2000);});}
      finally{active.delete(lane);}
    })();
    pending.add(task);task.finally(()=>pending.delete(task)).catch(()=>{stop();});
  }
  await new Promise(r=>setTimeout(r,1000));
}
await Promise.allSettled([...pending]);
});
