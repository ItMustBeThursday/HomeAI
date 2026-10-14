import fs from 'node:fs/promises';
import path from 'node:path';
import {JobStore,safe,atomic} from './jobs-plugin/store.mjs';
const root=process.argv[2];
const settings=JSON.parse(await fs.readFile(await safe(root,'homeai.json'),'utf8'));
if(settings.owner!=='home-ai-kit-v1'||path.resolve(settings.root)!==path.resolve(root))throw Error('HomeAI ownership differs.');
const config=JSON.parse(await fs.readFile(await safe(root,'state','openclaw','openclaw.json'),'utf8'));
const report={owner:'home-ai-audit-v1',at:new Date().toISOString(),main:config.agents?.defaults?.model,
  chatSelectionScope:config.agents?.defaults?.modelSelectionScope||'session',maxConcurrent:config.agents?.defaults?.maxConcurrent,
  workers:{},plugins:{},memory:{provider:config.memory?.search?.provider,rememberAcrossConversations:config.memory?.search?.rememberAcrossConversations},
  persistence:{jobRecords:'state/jobs/records',planRecords:'state/jobs/plans',checkpointRecords:'state/workbench/tasks',expectedOutputHashesOnly:true,automaticWindowsStartup:false},models:[],warnings:[]};
for(const lane of ['codex','claude','local']){
  const entry=config.agents?.entries?.['homeai-worker-'+lane];report.workers[lane]=entry?{configured:true,model:entry.model,tools:entry.tools?.allow,liveInferenceVerified:false}:{configured:false};
}
for(const id of ['homeai-workbench','homeai-jobs','codex','anthropic'])report.plugins[id]={enabled:config.plugins?.entries?.[id]?.enabled===true};
try{
  const response=await fetch('http://127.0.0.1:'+settings.ollamaPort+'/api/tags',{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('HTTP '+response.status);
  const tags=await response.json();
  for(const model of config.models?.providers?.ollama?.models||[]){const found=tags.models?.find(m=>m.name===model.id);report.models.push({id:model.id,input:model.input,installed:!!found,bytes:found?.size});}
}catch{report.warnings.push('Local Ollama model inventory could not be read.');}
const jobs=await new JobStore(root).list();report.persistence.jobsByStatus={};
for(const job of jobs)report.persistence.jobsByStatus[job.status]=(report.persistence.jobsByStatus[job.status]||0)+1;
if(Object.values(report.workers).some(w=>!w.configured))report.warnings.push('Parallel worker roster is incomplete.');
if(report.memory.provider==='none')report.warnings.push('Memory recall uses keyword search; semantic embeddings are not enabled.');
report.warnings.push('Configured hosted workers still need a real target-PC job to confirm account access. No hosted inference was performed by this audit.');
const file=await safe(root,'state','homeai-audit.json');await atomic(file,report);
console.log(JSON.stringify(report,null,2));console.log('Saved filtered audit: '+file);
