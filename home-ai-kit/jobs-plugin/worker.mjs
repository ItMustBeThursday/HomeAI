import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {JobStore,safe,atomic,withLock,stepPrompt,controlReply,settle} from './store.mjs';
const root=process.argv[2];if(!root)throw Error('Pass HomeAI root.');
const settings=JSON.parse(await fs.readFile(await safe(root,'homeai.json'),'utf8'));
if(settings.owner!=='home-ai-kit-v1'||path.resolve(settings.root)!==path.resolve(root))throw Error('HomeAI ownership differs.');
const store=new JobStore(root);let stopping=false,active=null;
await withLock(await safe(root,'state','jobs','runner.lock'),async()=>{
process.on('SIGTERM',()=>{stopping=true;active?.kill('SIGTERM');});process.on('SIGINT',()=>{stopping=true;active?.kill('SIGINT');});
// A previous dispatch may have been accepted. Never automatically replay it.
for(const job of await store.list())if(['running','pause-requested'].includes(job.status))await store.update(job.id,j=>{j.status='interrupted';j.lastError='Gateway/worker stopped during an uncertain dispatch. Inspect its session before explicitly resuming.';});
async function runTurn(job){
  const promptFile=await safe(root,'state','jobs','prompts',job.id+'-'+job.attempt+'.txt');await fs.mkdir(path.dirname(promptFile),{recursive:true});await fs.writeFile(promptFile,stepPrompt(job));
  const claw=await safe(root,'runtime','openclaw','node_modules','openclaw','openclaw.mjs');
  const args=[claw,'agent','--agent','homeai-worker','--session-key','homeai-job-'+job.id,'--message-file',promptFile,'--timeout','180','--json'];
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',tooLarge=false;
    active=spawn(process.execPath,args,{shell:false,windowsHide:true,cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
    const processRef=active;
    const timer=setTimeout(()=>processRef.kill('SIGTERM'),620000);
    processRef.stdout.on('data',data=>{stdout+=data;if(stdout.length>4*1024*1024){tooLarge=true;processRef.kill('SIGTERM');}});
    processRef.stderr.on('data',data=>{stderr=(stderr+data).slice(-2000);});
    processRef.on('error',error=>{clearTimeout(timer);active=null;reject(error);});
    processRef.on('close',async code=>{
      clearTimeout(timer);active=null;
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
        resolve(control);
      }catch(error){reject(error);}
    });
  });
}
while(!stopping){
  const next=(await store.list()).filter(j=>j.status==='queued').sort((a,b)=>a.createdAt.localeCompare(b.createdAt))[0];
  if(!next){await new Promise(r=>setTimeout(r,3000));continue;}
  let job;
  try{job=await store.update(next.id,j=>{if(j.status!=='queued')throw Error('Job state changed before dispatch.');j.status='running';j.attempt++;j.dispatch={at:new Date().toISOString(),sessionKey:'agent:homeai-worker:homeai-job-'+j.id};});}
  catch(error){if(error.message==='Job state changed before dispatch.')continue;throw error;}
  try{await settle(store,job.id,await runTurn(job));}
  catch(error){await store.update(job.id,j=>{j.status='interrupted';j.lastError=error.message.slice(0,2000);});}
}
});
