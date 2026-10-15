import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {recoveryPlan} from './recovery-plan.mjs';
const [root,action,primary='Codex']=process.argv.slice(2);
async function safe(...parts){const base=path.resolve(root),file=path.resolve(base,...parts);if(file!==base&&!file.startsWith(base+path.sep))throw Error('Recovery path escapes HomeAI.');for(let p=file;;p=path.dirname(p)){try{const s=await fs.lstat(p);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))throw Error('Recovery refuses links.');}catch(e){if(e.code!=='ENOENT')throw e;}if(path.dirname(p)===p)break;}return file;}
const read=async(...parts)=>JSON.parse((await fs.readFile(await safe(...parts),'utf8')).replace(/^\uFEFF/,''));
const settings=await read('homeai.json');if(settings.owner!=='home-ai-kit-v1'||path.resolve(settings.root)!==path.resolve(root))throw Error('HomeAI ownership differs.');
const file=await safe('state','openclaw','openclaw.json'),source=await read('state','openclaw','openclaw.json');
const claw=await safe('runtime','openclaw','node_modules','openclaw','openclaw.mjs');
function cli(args){return new Promise((resolve,reject)=>{
  let output='',stderr='',size=0;const child=spawn(process.execPath,[claw,...args],{cwd:root,shell:false,windowsHide:true,env:process.env,stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>{child.kill();reject(Error('Recovery control-plane command exceeded 90 seconds.'));},90000);
  const capture=(data,error=false)=>{size+=data.length;if(size>4*1024**2){child.kill();return;}if(error)stderr+=data.toString();else output+=data.toString();};
  child.stdout.on('data',d=>capture(d));child.stderr.on('data',d=>capture(d,true));
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);if(size>4*1024**2)return reject(Error('Recovery command output exceeded its bound.'));if(code!==0)return reject(Error('Control-plane command failed: '+args.slice(0,3).join(' ')+'. Inspect local logs; no credentials were printed.'));try{resolve(JSON.parse(output.trim()));}catch{reject(Error('Expected JSON from control-plane command. Inspect local CLI output.'));}});
});}
async function inventory(){try{const response=await fetch('http://127.0.0.1:'+settings.ollamaPort+'/api/tags',{signal:AbortSignal.timeout(5000)});if(response.ok)return (await response.json()).models||[];}catch{}return [];}
if(action==='apply'||action==='plan'){
  const tags=action==='apply'?await inventory():[];
  const plan=recoveryPlan(source,{primary,mainModel:settings.mainModel,fastInstalled:tags.some(t=>t.name==='homeai-fast:locked')});
  if(action==='apply'){
    const bytes=JSON.stringify(plan.config,null,2),temporary=await safe('state','openclaw','openclaw.json.recovery-'+randomUUID()+'.tmp');
    await fs.writeFile(temporary,bytes,{flag:'wx'});await fs.rename(temporary,file);
  }
  console.log(JSON.stringify({ref:plan.ref,runtime:plan.runtime,changes:plan.changes,paused:true,configSha256:createHash('sha256').update(action==='apply'?JSON.stringify(plan.config,null,2):JSON.stringify(source)).digest('hex')}));
} else if(action==='create'){
  const plan={ref:source.agents.entries.main.model.primary,runtime:primary==='Claude'?'claude-cli':primary==='Local'?'openclaw':'codex'};
  const key='agent:main:homeai-recovery-'+randomUUID();
  const response=await cli(['gateway','call','sessions.create','--params',JSON.stringify({key,agentId:'main',model:plan.ref,agentRuntime:plan.runtime,label:'HomeAI recovery '+new Date().toISOString().replace(/[:.]/g,'-'),idempotencyKey:randomUUID()}),'--json','--timeout','60000']);
  if(response.ok===false||response.error)throw Error('Gateway refused recovery chat creation. No existing session was reset.');
  console.log(JSON.stringify({key,ref:plan.ref,runtime:plan.runtime,sessionId:response.sessionId??response.result?.sessionId??null,created:true}));
} else if(action==='plugins'){
  const plugins=[];
  for(const id of ['codex','anthropic']){
    try {const response=await cli(['plugins','inspect',id,'--runtime','--json']);const p=response.plugin||{};plugins.push({id,status:p.status,origin:p.origin,source:p.source,version:p.version,diagnosticLevels:(response.diagnostics||[]).map(d=>d.level)});}
    catch(error){plugins.push({id,status:'inspection-failed',error:error.message});}
  }
  console.log(JSON.stringify({plugins}));
} else if(action==='sessions'){
  const response=await cli(['sessions','--agent','main','--json','--limit','20']);
  console.log(JSON.stringify({sessions:(response.sessions||[]).map(s=>({key:s.key,model:s.model,modelProvider:s.modelProvider,agentRuntimeOverride:s.agentRuntimeOverride,agentHarnessId:s.agentHarnessId,modelSelectionLocked:s.modelSelectionLocked,totalTokens:s.totalTokens,contextTokens:s.contextTokens}))}));
} else throw Error('Unknown recovery operation.');
