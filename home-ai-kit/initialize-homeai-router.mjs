import fs from 'node:fs/promises';
import path from 'node:path';
import {safe,settings,atomic,readSlot,change} from './autonomy-plugin/changes.mjs';
import {catalog} from './autonomy-plugin/catalog.mjs';
import {probe} from './autonomy-plugin/pool.mjs';
const root=process.argv[2],data=await settings(root),folder=await safe(root,'state','router');await fs.mkdir(folder,{recursive:true});
const file=await safe(folder,'pool.json');
if(['--enable','--disable'].includes(process.argv[3])){const prior=await readSlot(root,'pool'),value=JSON.parse(prior.text);value.enabled=process.argv[3]==='--enable';const record=await change(root,'pool',JSON.stringify(value,null,2),prior.sha256,(value.enabled?'Enable':'Disable')+' adaptive routing after configuration validation','installer');console.log('Router enabled='+value.enabled+'; restore ID '+record.id);process.exit(0);}
try{const existing=JSON.parse(await fs.readFile(file,'utf8'));if(existing.owner!=='home-ai-router-v1')throw Error('Existing router is not owned.');console.log('Existing model pool and feedback retained.');}
catch(e){if(e.code!=='ENOENT')throw e;
  const model=(id,ref,lane,agentId,priors,enabled=true)=>({id,ref,lane,agentId,priors,enabled,status:enabled?'configured-live-account-not-yet-verified':'staged-not-auto-routed'});
  const models=[
    model('astra','openai/gpt-6-astra','codex','homeai-worker-codex',{planning:.96,coding:.92,design:.85,review:.93,general:.9}),
    model('sol','openai/gpt-6.1-sol','codex','homeai-worker-codex-sol',{planning:.89,coding:.95,design:.9,review:.9,general:.89}),
    model('opus','anthropic/claude-opus-5-5','claude','homeai-worker-claude',{planning:.91,coding:.91,design:.95,review:.96,general:.9}),
    model('sonnet','anthropic/claude-sonnet-5-5','claude','homeai-worker-claude-sonnet',{planning:.85,coding:.88,design:.91,review:.9,general:.85}),
    model('qwen','ollama/'+data.mainModel,'local','homeai-worker-local',{planning:.65,coding:.8,design:.72,review:.73,quick:.85,general:.78}),
    model('fast','ollama/homeai-fast:locked','local','homeai-worker-local-fast',{quick:.93,general:.65},false),
    model('coder','ollama/homeai-coder:locked','local','homeai-worker-local-coder',{coding:.83,review:.75,general:.68},false),
    {id:'vision',ref:'ollama/homeai-vision:locked',kind:'specialist',enabled:false,status:'use-homeai-specialist-vision',priors:{}},
    {id:'embedding',ref:'ollama/homeai-embedding:locked',kind:'embedding',enabled:false,status:'staged-memory-backend-not-enabled',priors:{}}
  ];
  await atomic(file,{owner:'home-ai-router-v1',enabled:false,autoCoordinator:false,exploration:true,models,quotaBalance:'unknown-unless-native-provider-reports-it',apiBillingConfigured:false,at:new Date().toISOString()});
}
const guidance=await safe(folder,'guidance.txt');try{await fs.stat(guidance);}catch(e){if(e.code!=='ENOENT')throw e;await fs.writeFile(guidance,'Plan before implementation. Assign task roles so routing can choose models. Prefer local extraction/summaries and existing tools for image inspection. Require real checks for app logic and separate review of design/tests. Report actual model use, fallback, managed changes and remaining limitations. Improve from verified task outcomes and human feedback; do not mistake saved files for quality or run paid loops while idle.',{flag:'wx'});}
// Validate the installed small model before admitting it as a tool-using worker.
const response=await fetch('http://127.0.0.1:'+data.ollamaPort+'/api/tags',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('Owned Ollama inventory unavailable.');const tags=await response.json();
const spec=catalog.find(c=>c.id==='fast'),alias=tags.models?.find(m=>m.name===spec.alias);
if(alias?.digest.replace(/^sha256:/,'').startsWith(spec.prefix)){
  const current=await readSlot(root,'pool'),pool=JSON.parse(current.text),entry=pool.models.find(m=>m.id==='fast');
  if(!entry.probe){const health=await probe(root,spec);entry.enabled=health.readyForJobs;entry.status=health.readyForJobs?'tool-and-gpu-probed-quality-unverified':'installed-not-auto-routed';entry.digest=alias.digest;entry.probe=health;const revision=await change(root,'pool',JSON.stringify(pool,null,2),current.sha256,'Readiness-check the existing fast local model','installer');console.log('Fast model readiness report: '+JSON.stringify({health,changeId:revision.id}));}
}
console.log('Adaptive routing initialized. Hosted access must be confirmed by actual model identity in job history.');
