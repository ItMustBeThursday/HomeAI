import path from 'node:path';
import {spawn} from 'node:child_process';
import {JobStore,safe} from './store.mjs';
export default {id:'homeai-jobs',name:'HomeAI Jobs',register(api){
  const root=api.pluginConfig?.root;if(typeof root!=='string'||! /^[A-Za-z]:[\\/]/.test(root))throw Error('Configure an absolute Windows HomeAI root.');
  const store=new JobStore(root);let child=null;
  const checkSchema={type:'array',maxItems:10,items:{type:'object',additionalProperties:false,required:['kind','entry'],properties:{kind:{type:'string',enum:['test','syntax']},entry:{type:'string'}}}};
  api.on?.('before_prompt_build',(_event,ctx)=>{
    if(ctx.agentId!=='main'||!api.config?.agents?.entries?.['homeai-worker-local'])return;
    const execution=api.config?.plugins?.entries?.['homeai-execution']?.enabled===true;
    return {prependSystemContext:'HomeAI orchestrator: For substantial app/design/document requests, use homeai_job action plan to delegate independent file-producing assignments to codex (implementation), claude (design/critical review), and local (bounded extraction/checklists). Choose lanes by task, not merely to use every model. Parallel assignments own different expectedFiles. An assignment may edit an earlier output only when dependsOn transitively includes all earlier owners. Use unique keys and dependsOn earlier keys; a final integration/review assignment waits for relevant dependencies. Read saved outputs before summarizing. Keep small chat requests in chat. Never claim completion or passing tests just because files exist. Submit a plan rather than only describing hypothetical delegation. Persistence is saved job records, project files and checkpoints, not automatically learned model weights. Hosted lanes can fall back to local Qwen on provider failures; report actual models from job history. No arbitrary shell, system installs or external actions are available. '+(execution?'Offline JavaScript checks are enabled via homeai_check. For app logic request real node:test files, not just test-case prose; add requiredChecks [{kind:"test",entry:"logic.test.mjs"}] to the integration job so readiness requires passing tests on current source hashes. Codex can own app logic initially, Claude can own tests in parallel, then Codex depends on both assignments and owns app logic for bounded test/repair. Finally Claude can review saved results. Test evidence does not certify browser behavior or generated-test quality.':'Execution backend is not enabled; workers only generate files. Do not claim tests executed.')};
  });
  const summary=j=>({id:j.id,project:j.project,lane:j.lane||'legacy',planId:j.planId,dependsOn:j.dependsOn,requiredChecks:j.requiredChecks,checkEvidence:j.checkEvidence,status:j.status,step:j.step,maxSteps:j.maxSteps,verification:j.verification,lastError:j.lastError,model:j.history.at(-1)?.model,latest:j.history.at(-1)?.summary});
  api.registerTool({name:'homeai_job',label:'HomeAI project jobs',description:'Submit a bounded local project-file job, list/get progress, pause at the next turn boundary or explicitly resume. Requires expected output files. Jobs cannot run shell/tests or external actions. Ready-for-review is not tested/completed. Interrupted dispatches require session inspection before resume.',
    parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['plan','submit','list','get','pause','resume']},id:{type:'string'},project:{type:'string'},lane:{type:'string',enum:['codex','claude','local']},goal:{type:'string'},maxSteps:{type:'integer',minimum:1,maximum:6},expectedFiles:{type:'array',items:{type:'string'}},requiredChecks:checkSchema,tasks:{type:'array',minItems:2,maxItems:8,items:{type:'object',additionalProperties:false,required:['key','lane','goal','expectedFiles'],properties:{key:{type:'string'},lane:{type:'string',enum:['codex','claude','local']},goal:{type:'string'},expectedFiles:{type:'array',items:{type:'string'}},maxSteps:{type:'integer',minimum:1,maximum:6},requiredChecks:checkSchema,dependsOn:{type:'array',items:{type:'string'}}}}}}},
    execute:async(_id,p)=>{
      if((p.action==='plan'||p.lane)&&!api.config?.agents?.entries?.['homeai-worker-local'])throw Error('Enable-HomeAIOrchestrator.ps1 must configure the worker lanes first.');
      if((p.requiredChecks?.length||p.tasks?.some(t=>t.requiredChecks?.length))&&!api.config?.plugins?.entries?.['homeai-execution']?.enabled)throw Error('Enable-HomeAIExecution.ps1 must enable the isolated runner before requiring checks.');
      const value=p.action==='plan'?await store.createPlan(p):p.action==='submit'?summary(await store.create(p)):p.action==='list'?(await store.list()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100).map(summary):p.action==='get'?await store.get(p.id):summary(await store.control(p.id,p.action));
      return {content:[{type:'text',text:JSON.stringify(value)}],details:value};
    }
  },{optional:true});
  // Read-only command remains usable when the model turn queue is busy.
  api.registerCommand({name:'homeai_jobs',description:'List persistent HomeAI project jobs without using model inference',handler:async()=>({text:JSON.stringify((await store.list()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100).map(summary),null,2)})});
  api.registerService({id:'homeai-jobs-runner',async start(){
    if(child) return;
    const worker=await safe(root,'scripts','jobs-plugin','worker.mjs');
    child=spawn(process.execPath,[worker,root],{shell:false,windowsHide:true,cwd:root,env:process.env,stdio:'ignore'});
    child.on('error',error=>api.logger.error('HomeAI job worker failed: '+error.message));
    child.on('exit',()=>{child=null;});
  },async stop(){if(child){const stopping=child;stopping.kill('SIGTERM');await Promise.race([new Promise(resolve=>stopping.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,5000))]);child=null;}}});
}};
