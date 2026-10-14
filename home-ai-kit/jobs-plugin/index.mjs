import path from 'node:path';
import {spawn} from 'node:child_process';
import {JobStore,safe} from './store.mjs';
export default {id:'homeai-jobs',name:'HomeAI Jobs',register(api){
  const root=api.pluginConfig?.root;if(typeof root!=='string'||! /^[A-Za-z]:[\\/]/.test(root))throw Error('Configure an absolute Windows HomeAI root.');
  const store=new JobStore(root);let child=null;
  const summary=j=>({id:j.id,project:j.project,status:j.status,step:j.step,maxSteps:j.maxSteps,verification:j.verification,lastError:j.lastError,model:j.history.at(-1)?.model,latest:j.history.at(-1)?.summary});
  api.registerTool({name:'homeai_job',label:'HomeAI project jobs',description:'Submit a bounded local project-file job, list/get progress, pause at the next turn boundary or explicitly resume. Requires expected output files. Jobs cannot run shell/tests or external actions. Ready-for-review is not tested/completed. Interrupted dispatches require session inspection before resume.',
    parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['submit','list','get','pause','resume']},id:{type:'string'},project:{type:'string'},goal:{type:'string'},maxSteps:{type:'integer',minimum:1,maximum:6},expectedFiles:{type:'array',items:{type:'string'}}}},
    execute:async(_id,p)=>{
      const value=p.action==='submit'?summary(await store.create(p)):p.action==='list'?(await store.list()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100).map(summary):p.action==='get'?await store.get(p.id):summary(await store.control(p.id,p.action));
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
