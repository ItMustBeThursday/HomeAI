import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const root = 'D:/HomeAI/projects/orchestrator';
const backup = 'D:/HomeAI/backups/webui-recovery-20261016-' + Date.now();
mkdirSync(backup, { recursive:true });
for (const f of ['web/app.js','web/media.js','web/style.css','web/index.html','src/orchestrator.mjs','src/router.mjs','config/routes.json']) {
  const dest = join(backup, f); mkdirSync(join(dest, '..'), { recursive:true }); copyFileSync(join(root,f),dest);
}
console.log('Backup:', backup);
const tasks = readFileSync(join(root,'data/tasks.jsonl'),'utf8').trim().split('\n').map(s=>{try{return JSON.parse(s)}catch{return {}}});
console.log(JSON.stringify(tasks.filter(t=>!t.ok && t.source==='chat').slice(-3).map(t=>({id:t.id,ts:t.ts,route:t.taskType,attempts:t.attempts})),null,2));
