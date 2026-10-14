import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {change,restore,readSlot} from '../home-ai-kit/autonomy-plugin/changes.mjs';
import {queueStage,runStage} from '../home-ai-kit/autonomy-plugin/pool.mjs';
import {catalog} from '../home-ai-kit/autonomy-plugin/catalog.mjs';
const root=path.resolve('tests/artifacts/managed-'+Date.now());await fs.mkdir(path.join(root,'state/router'),{recursive:true});await fs.mkdir(path.join(root,'models/ollama'),{recursive:true});
await fs.writeFile(path.join(root,'state/router/guidance.txt'),'Original instructions.');await fs.writeFile(path.join(root,'state/router/pool.json'),JSON.stringify({owner:'home-ai-router-v1',enabled:true,models:[{id:'fast',enabled:false}]}));
const tags=[];const spec=catalog.find(c=>c.id==='fast');
const server=http.createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;const body=text?JSON.parse(text):{};let value={};if(req.url==='/api/tags')value={models:tags};if(req.url==='/api/pull')tags.push({name:body.model,digest:spec.prefix+'fixture'});if(req.url==='/api/copy')tags.push({name:body.destination,digest:spec.prefix+'fixture'});if(req.url==='/api/show')value={capabilities:['tools']};if(req.url==='/api/chat')value={message:{tool_calls:[{function:{name:'homeai_probe',arguments:{value:7}}}]}};if(req.url==='/api/ps')value={models:[{name:spec.alias,size:100,size_vram:100}]};res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));await fs.writeFile(path.join(root,'homeai.json'),JSON.stringify({owner:'home-ai-kit-v1',root,backupRoot:path.join(root,'backups'),ollamaPort:server.address().port}));
try{
 const before=await readSlot(root,'guidance');await assert.rejects(change(root,'guidance','new','stale','why'),/read it again/);
 const record=await change(root,'guidance','Better instructions.',before.sha256,'Improve decomposition');assert.equal(record.verifiedBackup,true);assert.equal((await readSlot(root,'guidance')).text,'Better instructions.');
 await restore(root,record.id);assert.equal((await readSlot(root,'guidance')).text,before.text);await assert.rejects(restore(root,record.id),/newer change/);
 const queued=await queueStage(root,'fast','Reduce summarization load on hosted models');await runStage(root,queued);
 const row=JSON.parse(await fs.readFile(path.join(root,'state/router/stages',queued.id+'.json'),'utf8'));assert.equal(row.status,'finished');assert.equal(row.health.readyForJobs,true);
 await restore(root,row.changeId);assert.equal(JSON.parse((await readSlot(root,'pool')).text).models[0].enabled,false,'Restore disables routing without deleting weights.');
 await assert.rejects(queueStage(root,'arbitrary-internet-model','bad'),/checked catalogue/);
 console.log('PASS: stale guidance refusal, verified restorable revisions, async stage records, pinned source/alias and synthetic readiness checks, routing rollback without model deletion. No weight downloads.');
}finally{await new Promise(r=>server.close(r));}
