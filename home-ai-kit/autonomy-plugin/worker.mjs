import fs from 'node:fs/promises';
import path from 'node:path';
import {safe,settings,atomic} from './changes.mjs';
import {withFileLock} from './lock.mjs';
import {stages,runStage} from './pool.mjs';
const root=process.argv[2];await settings(root);let stopped=false;process.on('SIGTERM',()=>stopped=true);process.on('SIGINT',()=>stopped=true);
await withFileLock(await safe(root,'state','router','stage-worker.lock'),async()=>{
  for(const row of await stages(root))if(['downloading','probing'].includes(row.status)){row.status='needs-review';row.error='Worker stopped during staging; inspect before staging again. Downloaded weights may remain.';await atomic(await safe(root,'state','router','stages',row.id+'.json'),row);}
  while(!stopped){const next=(await stages(root)).reverse().find(r=>r.status==='queued');if(next){
    // Downloading does not load VRAM, but the following readiness probe does.
    // Wait for background jobs to settle to avoid deliberately displacing them.
    let busy=false;const jobs=await safe(root,'state','jobs','records');try{for(const name of await fs.readdir(jobs)){if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;const row=JSON.parse(await fs.readFile(await safe(jobs,name),'utf8'));if(['running','pause-requested','queued'].includes(row.status))busy=true;}}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!busy)await runStage(root,next);
  }await new Promise(r=>setTimeout(r,3000));}
});
