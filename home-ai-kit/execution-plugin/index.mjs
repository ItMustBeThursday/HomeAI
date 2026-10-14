import fs from 'node:fs';
import path from 'node:path';
import {checkProject} from './broker.mjs';
export default {id:'homeai-execution',name:'HomeAI Offline Checks',register(api){
  const root=api.pluginConfig?.root;if(typeof root!=='string'||! /^[A-Za-z]:[\\/]/.test(root))throw Error('Configure an absolute Windows HomeAI root.');
  api.registerTool(ctx=>{
    let scope=null,jobId=null;
    if(ctx.agentId!=='main'){
      const match=/^agent:(homeai-worker-(?:codex|claude|local)):homeai-job-([a-f0-9-]{36})$/.exec(ctx.sessionKey||'');
      if(!match||ctx.agentId!==match[1])return null;
      try{
        const file=path.join(root,'state/jobs/records',match[2]+'.json');let cursor=file;
        while(true){const s=fs.lstatSync(cursor);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))return null;const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
        const job=JSON.parse(fs.readFileSync(file,'utf8'));if(job.owner!=='home-ai-job-v1'||job.id!==match[2]||'homeai-worker-'+job.lane!==ctx.agentId)return null;
        scope=job.project;jobId=job.id;
      }catch{return null;}
    }
    return {name:'homeai_check',label:'Offline JavaScript checks',description:'Check syntax or execute dependency-free node:test tests on a copied project snapshot inside Windows AppContainer with no network capabilities. Snapshot read-only, no shell/install/child processes. Saves genuine exit code, test count, logs and source hashes. Files in the live project are not modified. Passing generated tests requires review; do not claim a full app was validated.',parameters:{type:'object',additionalProperties:false,required:['project','kind','entry'],properties:{project:{type:'string'},kind:{type:'string',enum:['syntax','test']},entry:{type:'string'}}},execute:async(_id,p)=>{const value=await checkProject(root,p,{projectScope:scope,jobId});return {content:[{type:'text',text:JSON.stringify(value)}],details:value};}};
  },{optional:true,names:['homeai_check']});
}};
