export const lanes=['codex','claude','local'];
export function agentFor(job){return job.routed?.agentId||(job.lane?'homeai-worker-'+job.lane:'homeai-worker');}
export function laneFor(job){return job.lane||'legacy';}
export function overlap(a,b){
  if(a.project!==b.project)return false;
  // Legacy jobs were allowed to write any file in their project.
  if(!a.lane||!b.lane)return true;
  const names=new Set(a.expectedFiles.map(f=>f.replaceAll('\\','/').toLowerCase()));
  return b.expectedFiles.some(f=>{const name=f.replaceAll('\\','/').toLowerCase();return [...names].some(other=>other===name||other.startsWith(name+'/')||name.startsWith(other+'/'));});
}
export async function eligible(store,job,jobs,active){
  if(job.status!=='queued'||active.some(j=>laneFor(j)===laneFor(job)||overlap(j,job)))return false;
  if(job.planId){
    const plan=await store.getPlan(job.planId);
    if(plan.status!=='committed')return false;
  }
  return (job.dependsOn||[]).every(id=>jobs.find(j=>j.id===id)?.status==='ready-for-review');
}
