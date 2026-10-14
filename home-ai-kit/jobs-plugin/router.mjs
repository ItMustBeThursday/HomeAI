import fs from 'node:fs/promises';
import {safe,atomic,withLock} from './store.mjs';
export const roles=['planning','coding','design','review','quick','general'];
export const routeAgents=['homeai-worker-codex','homeai-worker-codex-sol','homeai-worker-claude','homeai-worker-claude-sonnet','homeai-worker-local','homeai-worker-local-fast','homeai-worker-local-coder'];
export function inferRole(goal){
  if(/\b(review|critique|audit)\b/i.test(goal))return 'review';
  if(/\b(plan|architecture|architect|requirements|strategy)\b/i.test(goal))return 'planning';
  if(/\b(design|layout|styling|document|proposal)\b/i.test(goal))return 'design';
  if(/\b(code|coding|implement|debug|repair|function|test|app\.js|logic\.mjs)\b/i.test(goal))return 'coding';
  if(/\b(extract|summarize|classify|checklist|acceptance.cases)\b/i.test(goal))return 'quick';return 'general';
}
export async function pool(root){
  try{const data=JSON.parse(await fs.readFile(await safe(root,'state','router','pool.json'),'utf8'));if(data.owner!=='home-ai-router-v1'||!Array.isArray(data.models))throw Error('Router ownership differs.');return data;}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export async function observations(root){
  try{const index=JSON.parse(await fs.readFile(await safe(root,'state','router','observations-index.json'),'utf8'));if(index.owner!=='home-ai-router-index-v1'||!Array.isArray(index.rows))throw Error('Observation index ownership differs.');return index.rows;}catch(e){if(e.code!=='ENOENT')throw e;}
  const folder=await safe(root,'state','router','observations');let names=[];try{names=await fs.readdir(folder);}catch(e){if(e.code!=='ENOENT')throw e;}
  const rows=[];for(const name of names.filter(n=>/^[a-f0-9-]{36}-\d+\.json$/.test(n))){const row=JSON.parse(await fs.readFile(await safe(folder,name),'utf8'));if(row.owner==='home-ai-router-observation-v1')rows.push(row);}return rows.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,1000);
}
export function rank(models,role,rows,{lane,importance='normal',busyLanes=[],now=Date.now()}={}){
  if(!roles.includes(role))throw Error('Unsupported task role.');
  return models.filter(m=>m.enabled&&m.agentId&&routeAgents.includes(m.agentId)&&m.priors?.[role]!==undefined&&(!lane||m.lane===lane)&&(importance!=='high'||m.priors[role]>=0.85)).map(m=>{
    const turns=rows.filter(r=>r.actualModel===m.ref&&r.role===role);
    const byJob=new Map();for(const row of turns.sort((a,b)=>b.at.localeCompare(a.at)))if(!byJob.has(row.jobId))byJob.set(row.jobId,row);
    const samples=[...byJob.values()],rated=samples.filter(r=>typeof r.humanScore==='number'),checked=samples.filter(r=>r.checksPassed===true);
    const latency=samples.filter(r=>Number.isFinite(r.durationMs));const usage=samples.filter(r=>Number.isFinite(r.tokens?.total));
    const meanMs=latency.length?latency.reduce((n,r)=>n+r.durationMs,0)/latency.length:null;
    const meanTokens=usage.length?usage.reduce((n,r)=>n+r.tokens.total,0)/usage.length:null;
    // Outputs existing is not quality evidence. Human scores carry more weight
    // than generated-test success. Small samples cannot rewrite role preferences.
    let adjustment=0;
    if(samples.length>=5&&rated.length>=3)adjustment=Math.max(-0.25,Math.min(0.25,(rated.reduce((n,r)=>n+r.humanScore/5,0)/rated.length-0.75)*0.6));
    else if(samples.length>=5&&checked.length>=5)adjustment=0.02;
    const misses=rows.filter(r=>r.requestedModel===m.ref&&r.actualModel&&r.actualModel!==m.ref&&now-Date.parse(r.at)<600000).length;
    const latencyPenalty=meanMs===null?0:Math.min(0.05,meanMs/240000*0.05);
    const tokenPenalty=meanTokens===null?0:Math.min(0.05,meanTokens/50000*0.05);
    const queuePenalty=importance==='high'?0:busyLanes.includes(m.lane)?0.125:0;
    const score=m.priors[role]+adjustment-latencyPenalty-tokenPenalty-queuePenalty-(misses?0.3:0);
    return {id:m.id,ref:m.ref,agentId:m.agentId,lane:m.lane,score,samples:samples.length,rated:rated.length,checked:checked.length,meanMs,meanTokens,fallbackPressure:misses>0,reason:{rolePrior:m.priors[role],qualityAdjustment:adjustment,latencyPenalty,tokenPenalty,queuePenalty,missingUsageIsUnknown:meanTokens===null}};
  }).sort((a,b)=>b.score-a.score);
}
export async function select(root,p){
  const data=await pool(root);if(!data?.enabled)return null;
  const role=p.role||inferRole(p.goal);if(!roles.includes(role))throw Error('Choose a supported task role.');
  const rows=await observations(root);
  const candidates=rank(data.models,role,rows,{lane:p.lane,importance:p.importance,busyLanes:p.busyLanes});
  if(!candidates.length)throw Error('No enabled route meets that role/provider/importance requirement.');
  const jobs=new Set(rows.filter(r=>r.role===role).map(r=>r.jobId));
  const explore=data.exploration&&p.importance!=='high'&&jobs.size>0&&jobs.size%10===9;
  const alternative=candidates.slice(1).find(c=>c.reason.rolePrior>=0.8&&!c.fallbackPressure);
  const best=explore&&alternative?alternative:candidates[0];return {role,lane:best.lane,agentId:best.agentId,requestedModel:best.ref,reason:{...best.reason,controlledExploration:best!==candidates[0]},score:best.score,selectedAt:new Date().toISOString()};
}
export async function observe(root,job,reply,durationMs){
  const data=await pool(root);if(!data?.enabled)return;
  const actual=reply.provider&&reply.model?(reply.model.startsWith(reply.provider+'/')?reply.model:reply.provider+'/'+reply.model):null;
  const row={owner:'home-ai-router-observation-v1',jobId:job.id,attempt:job.attempt,role:job.role||inferRole(job.goal),requestedModel:job.routed?.requestedModel||null,actualModel:actual,durationMs,tokens:reply.tokens||null,checksPassed:job.checkEvidence?.some(c=>c.kind==='test')||false,status:job.status,at:new Date().toISOString(),humanScore:null};
  await withLock(await safe(root,'state','router','metrics.lock'),async()=>{const rows=await observations(root);await atomic(await safe(root,'state','router','observations',job.id+'-'+job.attempt+'.json'),row);const index=[row,...rows.filter(r=>r.jobId!==row.jobId||r.attempt!==row.attempt)].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,1000);await atomic(await safe(root,'state','router','observations-index.json'),{owner:'home-ai-router-index-v1',rows:index});});
}
export async function rate(root,id,score){
  if(!/^[a-f0-9-]{36}$/.test(id)||!Number.isInteger(score)||score<1||score>5)throw Error('Use /homeai_rate JOB-ID 1-to-5.');
  return withLock(await safe(root,'state','router','metrics.lock'),async()=>{
  const all=await observations(root),rows=all.filter(r=>r.jobId===id),models=new Set(rows.map(r=>r.actualModel).filter(Boolean));
  if(!rows.length)throw Error('No recorded model observations for that job.');
  if(models.size!==1)throw Error('This job used multiple models; a single job rating cannot fairly credit one model.');
  for(const row of rows){row.humanScore=score;row.feedbackSource='human-command';await atomic(await safe(root,'state','router','observations',row.jobId+'-'+row.attempt+'.json'),row);}
  await atomic(await safe(root,'state','router','observations-index.json'),{owner:'home-ai-router-index-v1',rows:all});
  return {jobId:id,score,model:[...models][0],message:'Saved human feedback; future routes recompute from accumulated evidence.'};
  });
}
