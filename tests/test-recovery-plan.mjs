import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {recoveryPlan} from '../home-ai-kit/recovery-plan.mjs';
import jobs from '../home-ai-kit/jobs-plugin/index.mjs';
const config={agents:{defaults:{models:{'openai/gpt-6-astra':{agentRuntime:{id:'claude-cli'}},'ollama/homeai-main:locked':{agentRuntime:{id:'claude-cli'}}},model:{primary:'anthropic/claude-opus-5-5'},utilityModel:'ollama/homeai-main:locked',compaction:{model:'ollama/homeai-main:locked'},maxConcurrent:4},entries:{main:{models:{'openai/gpt-6-astra':{agentRuntime:{id:'claude-cli'}}},workspace:'D:\\HomeAI\\workspace',tools:{profile:'full',exec:{mode:'full'}}},'homeai-worker-local':{model:{primary:'ollama/homeai-main:locked'},tools:{allow:['homeai_project']}}}},tools:{profile:'full',exec:{mode:'full'},deny:['message']},plugins:{entries:{codex:{enabled:true,config:{appServer:{sandbox:'danger-full-access',approvalPolicy:'never'}}},anthropic:{enabled:true},'homeai-jobs':{enabled:true,config:{root:'D:\\HomeAI'}},'homeai-autonomy':{enabled:true,config:{root:'D:\\HomeAI'}}}},cron:{enabled:true}};
config.agents.ownership='explicit';
const before=structuredClone(config),plan=recoveryPlan(config);
assert.deepEqual(config,before,'Planning mutated the original configuration');
assert.equal(plan.config.agents.entries.main.models['openai/gpt-6-astra'].agentRuntime.id,'codex','Agent-local override still shadows the native Codex mapping');
assert.equal(plan.config.agents.defaults.models['ollama/homeai-main:locked'].agentRuntime.id,'openclaw');
assert.deepEqual(plan.config.tools,config.tools,'Recovery reset operator tool permissions');
assert.deepEqual(plan.config.plugins.entries.codex.config,config.plugins.entries.codex.config,'Recovery reset native sandbox permissions');
assert.deepEqual(plan.config.agents.entries['homeai-worker-local'],config.agents.entries['homeai-worker-local'],'Recovery changed a worker or its scoped tools');
assert.deepEqual(plan.config.agents.entries.main.model.fallbacks,[],'A huge native transcript can still fall into the local fallback');
assert.equal(plan.config.plugins.entries['homeai-jobs'].enabled,false);
assert.equal(plan.config.agents.defaults.utilityModel,undefined);
assert.equal(plan.config.agents.defaults.compaction.model,undefined);
const local=recoveryPlan(config,{primary:'Local',fastInstalled:true});
assert.equal(local.ref,'ollama/homeai-fast:locked');
assert.deepEqual(local.config.tools.allow,['homeai_project','homeai_task']);
const hooks=[];jobs.register({pluginConfig:{root:'D:\\HomeAI'},on:name=>hooks.push(name),registerTool(){},registerCommand(){},registerService(){}});
assert(!hooks.includes('before_model_resolve'),'Main chat can still cross provider without migrating native runtime/transcript');
if(process.argv[2]){
  const {t:schema}=await import(pathToFileURL(process.argv[2]));
  for(const primary of ['Codex','Claude','Local']){
    const checked=schema.safeParse(recoveryPlan(config,{primary}).config);
    assert(checked.success,JSON.stringify(checked.error?.issues));
  }
}
console.log('PASS: per-agent runtime repair, scope/permission preservation, no cross-runtime fallback or main-chat hook, and supplied core schema. No inference or services started.');
