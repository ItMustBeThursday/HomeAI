// Development-only: actual pinned Gateway and job worker, synthetic local model.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {JobStore} from '../home-ai-kit/jobs-plugin/store.mjs';
import {createHash} from 'node:crypto';
const root=path.resolve('tests/artifacts/jr-'+Date.now());
const fleet=process.argv.includes('--fleet');let concurrent=0,maxConcurrent=0;
const execution=process.argv.includes('--execution');
let release;const barrier=new Promise(r=>release=r);let firstRequests=0;
const captured=[];
await fs.mkdir(path.join(root,'workspace'),{recursive:true});
for(const folder of ['jobs-plugin','workbench-plugin'])await fs.cp(path.resolve('home-ai-kit',folder),path.join(root,'scripts',folder),{recursive:true});
if(execution){
  await fs.cp(path.resolve('home-ai-kit/execution-plugin'),path.join(root,'scripts/execution-plugin'),{recursive:true});
  for(const file of ['Common.ps1','Invoke-HomeAIIsolatedNode.ps1','IsolatedNode.cs'])await fs.copyFile(path.resolve('home-ai-kit',file),path.join(root,'scripts',file));
  await fs.mkdir(path.join(root,'runtime/isolated-node'),{recursive:true});
  const node=process.env.HOMEAI_TEST_NODE||process.execPath;await fs.copyFile(node,path.join(root,'runtime/isolated-node/node.exe'));
  await fs.mkdir(path.join(root,'state'),{recursive:true});await fs.writeFile(path.join(root,'state/execution-connector.json'),JSON.stringify({owner:'home-ai-execution-v1',enabled:true,nodeSha256:createHash('sha256').update(await fs.readFile(node)).digest('hex').toUpperCase()}));
}
const model=http.createServer(async(req,res)=>{
  let text='';for await(const data of req)text+=data;const input=text?JSON.parse(text):{};
  let body={models:[]};
  if(req.url==='/api/show')body={capabilities:['completion','tools'],model_info:{'general.architecture':'qwen'},parameters:'num_ctx 8192'};
  if(req.url==='/api/chat') {
    captured.push(input);
    concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
    if(fleet&&firstRequests<3){firstRequests++;if(firstRequests===3)release();await Promise.race([barrier,new Promise(r=>setTimeout(r,15000))]);}
    const last=input.messages?.at(-1);
    const canWrite=input.tools?.some(t=>t.function?.name==='homeai_project');
    const search=input.tools?.find(t=>/tool.*search/i.test(t.function?.name));
    const dispatch=input.tools?.find(t=>/(?:^|_)tool_call$/.test(t.function?.name||''));
    const context=JSON.stringify(input.messages);const filename=execution?'logic.test.mjs':fleet?(/README[123]\.md/.exec(context)?.[0]||'MISSING.md'):'README.md';
    const wrote=await fs.stat(path.join(root,'projects/demo',filename)).then(()=>true,()=>false);
    let reports=[];if(execution)try{for(const dir of await fs.readdir(path.join(root,'state/execution/runs')))try{reports.push(JSON.parse(await fs.readFile(path.join(root,'state/execution/runs',dir,'report.json'),'utf8')));}catch{}}catch{}
    const checked=reports.some(r=>r.status==='passed');
    const fixtureContent=execution?"import test from 'node:test';import assert from 'node:assert/strict';test('real gateway assertion',()=>assert.equal(2+3,5));":'Verified fixture output.';
    const message=!wrote&&canWrite?{role:'assistant',content:'',tool_calls:[{function:{name:'homeai_project',arguments:{action:'write',project:'demo',file:filename,content:fixtureContent}}}]}:
      execution&&!checked?{role:'assistant',content:'',tool_calls:[{function:{name:'homeai_check',arguments:{project:'demo',kind:'test',entry:filename}}}]}:
      !wrote&&dispatch?{role:'assistant',content:'',tool_calls:[{function:{name:dispatch.function.name,arguments:{id:'homeai_project',args:{action:'write',project:'demo',file:'README.md',content:'Verified fixture output.'}}}}]}:
      !wrote&&search?{role:'assistant',content:'',tool_calls:[{function:{name:search.function.name,arguments:{query:'homeai_project'}}}]}:
      {role:'assistant',content:JSON.stringify({decision:'ready',summary:'Created the required README.md.'})};
    body={model:'homeai-main:locked',message,done:true,eval_count:5,eval_duration:1000000000};
    concurrent--;
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body));
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const config=JSON.parse((await fs.readFile('tests/artifacts/workbench-config.json','utf8')).replace(/^\uFEFF/,''));
config.tools.profile='full';
config.tools.toolSearch=false;
config.gateway.port=port;config.agents.defaults.workspace=path.join(root,'workspace');config.agents.defaults.model={primary:'ollama/homeai-main:locked'};
config.agents.entries['homeai-worker']={workspace:path.join(root,'workspace'),tools:{allow:['homeai_project','homeai_task','homeai_specialist'],exec:{host:'gateway',mode:'ask'}}};
if(fleet){config.agents.defaults.maxConcurrent=4;for(const lane of ['codex','claude','local'])config.agents.entries['homeai-worker-'+lane]={workspace:path.join(root,'workspace'),model:{primary:'ollama/homeai-main:locked',fallbacks:[]},tools:{allow:['homeai_project'],exec:{host:'gateway',mode:'ask'}}};}
if(execution){config.tools.allow.push('homeai_check');config.agents.entries['homeai-worker-codex']={workspace:path.join(root,'workspace'),model:{primary:'ollama/homeai-main:locked',fallbacks:[]},tools:{allow:['homeai_project','homeai_check'],exec:{host:'gateway',mode:'ask'}}};}
config.agents.ownership='explicit';config.agents.defaults.systemAgent={agentId:'main'};
config.models.providers.ollama.baseUrl='http://127.0.0.1:'+model.address().port;
config.plugins={allow:['homeai-workbench','homeai-jobs','ollama'],load:{paths:[path.join(root,'scripts/workbench-plugin'),path.join(root,'scripts/jobs-plugin')]},entries:{'homeai-workbench':{enabled:true,config:{root}},'homeai-jobs':{enabled:true,config:{root}},ollama:{enabled:true}}};
if(execution){config.plugins.allow.push('homeai-execution');config.plugins.load.paths.push(path.join(root,'scripts/execution-plugin'));config.plugins.entries['homeai-execution']={enabled:true,config:{root}};}
const state=path.join(root,'state/openclaw');await fs.mkdir(state,{recursive:true});await fs.writeFile(path.join(state,'openclaw.json'),JSON.stringify(config));
await fs.writeFile(path.join(root,'homeai.json'),JSON.stringify({owner:'home-ai-kit-v1',root,backupRoot:path.join(root,'backups'),ollamaPort:model.address().port}));
const claw=path.resolve('research/openclaw-runtime-check/node_modules/openclaw/openclaw.mjs');
const launcher=path.join(root,'runtime/openclaw/node_modules/openclaw/openclaw.mjs');await fs.mkdir(path.dirname(launcher),{recursive:true});
await fs.writeFile(launcher,`process.argv[1]=${JSON.stringify(claw)};await import(${JSON.stringify(pathToFileURL(claw).href)});`);
const env={...process.env,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:path.join(state,'openclaw.json'),OPENCLAW_NO_AUTO_UPDATE:'1',OPENCLAW_TELEMETRY_ENABLED:'0',DO_NOT_TRACK:'1',OPENCLAW_NO_RESPAWN:'1',NODE_DISABLE_COMPILE_CACHE:'1'};
const store=new JobStore(root);let targets;
if(execution)targets=[(await store.create({project:'demo',lane:'codex',goal:'Create logic.test.mjs and run it with homeai_check.',expectedFiles:['logic.test.mjs'],requiredChecks:[{kind:'test',entry:'logic.test.mjs'}],maxSteps:1})).id];
else if(fleet){const plan=await store.createPlan({project:'demo',tasks:['codex','claude','local'].map((lane,i)=>({key:lane,lane,goal:'Create README'+(i+1)+'.md.',expectedFiles:['README'+(i+1)+'.md'],maxSteps:1}))});targets=plan.tasks.map(t=>t.id);}
else targets=[(await store.create({project:'demo',goal:'Create README.md.',expectedFiles:['README.md'],maxSteps:1})).id];
let log='';const gateway=spawn(process.env.HOMEAI_TEST_NODE||process.execPath,[claw,'gateway','run'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
for(const stream of [gateway.stdout,gateway.stderr])stream.on('data',data=>{log=(log+data).slice(-10000);});
try{
  for(let i=0;i<120;i++){
    if(gateway.exitCode!==null)throw Error('Gateway exited: '+log);
    const current=await Promise.all(targets.map(id=>store.get(id)));
    if(current.every(j=>j.status==='ready-for-review')) {
      for(const j of current){const text=await fs.readFile(path.join(root,'projects/demo',j.expectedFiles[0]),'utf8');if(execution){if(j.checkEvidence?.[0]?.passedTests!==1)throw Error('Actual execution evidence missing.');}else if(text!=='Verified fixture output.')throw Error('Output differs.');}
      if(fleet&&maxConcurrent<3)throw Error('Worker model requests did not overlap: '+maxConcurrent);
      console.log('PASS: actual OpenClaw Gateway service dispatched '+targets.length+' project-bound job(s), ran registered file tools and persisted verified output evidence. '+(fleet?'Three model requests overlapped. ':'')+(execution?'Registered check tool executed a real isolated Node test and job readiness required its evidence. ':'')+'Synthetic local models only; hosted account access not tested.');break;
    }
    if(current.some(j=>['interrupted','needs-review'].includes(j.status)))throw Error(JSON.stringify(current)+'\n'+log);
    if(i===119)throw Error('Job did not settle: '+JSON.stringify(current)+'\n'+log);
    await new Promise(r=>setTimeout(r,1000));
  }
}finally{
  if(gateway.exitCode===null){gateway.kill('SIGTERM');await new Promise(r=>gateway.once('close',r));}
  await fs.writeFile(path.join(root,'gateway.log'),log);
  await fs.writeFile(path.join(root,'model-requests.json'),JSON.stringify(captured,null,2));
  await new Promise(r=>model.close(r));
}
