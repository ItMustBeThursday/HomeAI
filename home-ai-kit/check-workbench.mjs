import fs from 'node:fs/promises';
import path from 'node:path';
import {createWorkbench} from './workbench-plugin/index.mjs';
const root=process.argv[2];
if(!root)throw Error('Pass the HomeAI installation root.');
const routes=JSON.parse(await fs.readFile(path.join(root,'state','specialist-routes.json'),'utf8'));
const settings=JSON.parse(await fs.readFile(path.join(root,'homeai.json'),'utf8'));
const tool=createWorkbench(root).find(t=>t.name==='homeai_specialist');
const checks=[];
for(const role of ['quick','vision']) {
  if(routes.roles[role]?.status!=='installed')continue;
  const reply=(await tool.execute('install-check',{task:role,prompt:'Reply with exactly READY. This is an installation check.'})).details;
  const response=await fetch('http://127.0.0.1:'+settings.ollamaPort+'/api/ps',{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Could not read local residency information.');
  const loaded=(await response.json()).models?.find(m=>m.name===reply.model);
  checks.push({role,model:reply.model,answer:reply.answer,elapsedNs:reply.elapsedNs,
    sizeBytes:loaded?.size,sizeVramBytes:loaded?.size_vram,context:loaded?.context_length,
    imagePipelineTested:false});
}
const report={checkedAt:new Date().toISOString(),checks,qualityCertified:false};
await fs.writeFile(path.join(root,'state','specialist-check.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
