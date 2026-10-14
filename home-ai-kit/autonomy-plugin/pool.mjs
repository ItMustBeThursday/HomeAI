import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {catalog} from './catalog.mjs';
import {safe,settings,atomic,readSlot,change} from './changes.mjs';
import {withFileLock} from './lock.mjs';
async function request(root,endpoint,body,timeout=10000){
  const data=await settings(root);if(!Number.isInteger(data.ollamaPort)||data.ollamaPort<1024||data.ollamaPort>65535)throw Error('Owned Ollama port differs.');
  const response=await fetch('http://127.0.0.1:'+data.ollamaPort+endpoint,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw Error('Ollama '+endpoint+' failed with HTTP '+response.status);const text=await response.text();return text?JSON.parse(text):{};
}
export async function stages(root){const folder=await safe(root,'state','router','stages');let names=[];try{names=await fs.readdir(folder);}catch(e){if(e.code!=='ENOENT')throw e;}const rows=[];for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){const row=JSON.parse(await fs.readFile(await safe(folder,name),'utf8'));if(row.owner==='home-ai-model-stage-v1')rows.push(row);}return rows.sort((a,b)=>b.at.localeCompare(a.at));}
export async function queueStage(root,modelId,reason){
  const spec=catalog.find(m=>m.id===modelId);if(!spec||typeof reason!=='string'||!reason.trim()||reason.length>1000)throw Error('Choose a checked catalogue model and explain why it is needed.');
  return withFileLock(await safe(root,'state','router','stage-queue.lock'),async()=>{
    const rows=await stages(root);if(rows.filter(r=>['queued','downloading','probing'].includes(r.status)).length>=2)throw Error('Two model stages are already pending.');
    if(rows.some(r=>r.modelId===modelId&&['queued','downloading','probing'].includes(r.status)))throw Error('That model stage is already pending.');
    const tags=await request(root,'/api/tags');const alias=tags.models?.find(m=>m.name===spec.alias);
    if(alias&&!alias.digest.replace(/^sha256:/,'').startsWith(spec.prefix))throw Error('Existing model alias differs; automatic replacement refused.');
    const reserveBytes=alias?0:spec.reserveBytes,today=new Date().toISOString().slice(0,10);
    if(rows.filter(r=>r.at.startsWith(today)).reduce((n,r)=>n+(r.reserveBytes||0),0)+reserveBytes>30*1024**3)throw Error('Automatic model download budget reached: 30 GiB per UTC day.');
    const models=await safe(root,'models','ollama');const disk=await fs.statfs(models);if(Number(disk.bavail)*Number(disk.bsize)<reserveBytes+25*1024**3)throw Error('Preserve 25 GiB free plus the staged model reserve.');
    const prior=await readSlot(root,'pool');const id=randomUUID(),row={owner:'home-ai-model-stage-v1',id,modelId,reason,reserveBytes,poolSha256:prior.sha256,status:'queued',at:new Date().toISOString(),source:spec.source,alias:spec.alias};
    await atomic(await safe(root,'state','router','stages',id+'.json'),row);return row;
  });
}
export async function probe(root,spec){
  const info=await request(root,'/api/show',{model:spec.alias});
  if(spec.kind!=='chat')return {readyForJobs:false,reason:'Specialist-only model; its separate backend remains unchanged.'};
  if(!info.capabilities?.includes('tools'))return {readyForJobs:false,reason:'Ollama did not declare tool capability.'};
  const started=Date.now();const reply=await request(root,'/api/chat',{model:spec.alias,stream:false,think:false,messages:[{role:'user',content:'Call homeai_probe exactly once with value 7. Do not answer in prose.'}],tools:[{type:'function',function:{name:'homeai_probe',description:'Return the probe value',parameters:{type:'object',required:['value'],properties:{value:{type:'integer'}},additionalProperties:false}}}],options:{num_ctx:8192,num_predict:128},keep_alive:'1m'},240000);
  const call=reply.message?.tool_calls?.find(c=>c.function?.name==='homeai_probe');let args=call?.function?.arguments;if(typeof args==='string')try{args=JSON.parse(args);}catch{}
  const loaded=await request(root,'/api/ps');const resident=loaded.models?.find(m=>m.name===spec.alias);
  const gpuFraction=resident?.size?resident.size_vram/resident.size:null;
  const ready=!!call&&args?.value===7&&gpuFraction!==null&&gpuFraction>=0.9;
  return {readyForJobs:ready,toolRoundTrip:!!call&&args?.value===7,gpuFraction,durationMs:Date.now()-started,reason:ready?'Synthetic tool call and mostly-GPU residency confirmed; quality still needs real jobs.':'Tool handling or mostly-GPU residency was not confirmed; kept out of automatic job routing.'};
}
export async function runStage(root,row){
  const file=await safe(root,'state','router','stages',row.id+'.json');const spec=catalog.find(m=>m.id===row.modelId);if(!spec)throw Error('Catalogue entry is missing.');
  try{
    if((await readSlot(root,'pool')).sha256!==row.poolSha256)throw Error('Pool changed after staging was requested; stage again against the current pool.');
    row.status='downloading';await atomic(file,row);
    let tags=await request(root,'/api/tags'),alias=tags.models?.find(m=>m.name===spec.alias);
    if(!alias){
      await request(root,'/api/pull',{model:spec.source,stream:false},1800000);
      tags=await request(root,'/api/tags');const source=tags.models?.find(m=>m.name===spec.source);
      if(!source?.digest.replace(/^sha256:/,'').startsWith(spec.prefix))throw Error('Downloaded source differs from the checked pin; alias was not created.');
      await request(root,'/api/copy',{source:spec.source,destination:spec.alias});tags=await request(root,'/api/tags');alias=tags.models?.find(m=>m.name===spec.alias);
    }
    if(!alias?.digest.replace(/^sha256:/,'').startsWith(spec.prefix))throw Error('Model alias differs from checked pin.');
    row.status='probing';row.digest=alias.digest;await atomic(file,row);
    const health=await probe(root,spec);
    const prior=await readSlot(root,'pool');if(prior.sha256!==row.poolSha256)throw Error('Pool changed during download; weights retained but routing not changed.');
    const data=JSON.parse(prior.text),model=data.models.find(m=>m.id===spec.id);if(!model)throw Error('Pool catalogue row differs.');
    model.enabled=health.readyForJobs;model.status=health.readyForJobs?'tool-and-gpu-probed-quality-unverified':'installed-not-auto-routed';model.digest=alias.digest;model.probe=health;
    const revision=await change(root,'pool',JSON.stringify(data,null,2),prior.sha256,'Stage '+spec.id+': '+row.reason,'model-stage-worker');
    row.status='finished';row.changeId=revision.id;row.health=health;row.finishedAt=new Date().toISOString();await atomic(file,row);
  }catch(e){row.status='needs-review';row.error=e.message;await atomic(file,row);}
}
