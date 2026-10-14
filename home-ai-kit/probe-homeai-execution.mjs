import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {checkProject,safe} from './execution-plugin/broker.mjs';
const root=process.argv[2],project='runner-probe-'+randomUUID().slice(0,8);
const folder=await safe(root,'projects',project);await fs.mkdir(folder,{recursive:true});
const outside=await safe(root,'state','execution','outside-probe-'+randomUUID()+'.txt');await fs.mkdir(path.dirname(outside),{recursive:true});await fs.writeFile(outside,'test fixture; not a credential',{flag:'wx'});
let connections=0;const server=http.createServer((_req,res)=>res.end('network-was-reachable'));
server.on('connection',()=>connections++);await new Promise(r=>server.listen(0,'127.0.0.1',r));
await fs.writeFile(path.join(folder,'logic.mjs'),'export const add=(a,b)=>a+b;',{flag:'wx'});
const source=`import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';import {add} from './logic.mjs';
test('real JavaScript assertions execute imported app logic',()=>assert.equal(add(2,3),5));
test('snapshot is read-only',()=>assert.throws(()=>fs.writeFileSync('changed.txt','bad'),e=>e.code==='ERR_ACCESS_DENIED'));
test('outside file read denied',()=>assert.throws(()=>fs.readFileSync(${JSON.stringify(outside)}),e=>e.code==='ERR_ACCESS_DENIED'));
test('child processes denied',()=>assert.throws(()=>cp.spawnSync('cmd.exe',['/c','echo unexpected']),e=>e.code==='ERR_ACCESS_DENIED'));
test('account environment removed',()=>{for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','CODEX_ACCESS_TOKEN','CLAUDE_CODE_OAUTH_TOKEN'])assert.equal(process.env[key],undefined);for(const key of ['LOCALAPPDATA','USERPROFILE'])assert.match(process.env[key],/homeai\\.test\\./i);});
test('network is inaccessible',async()=>{await assert.rejects(fetch('http://127.0.0.1:${server.address().port}/',{signal:AbortSignal.timeout(4000)}));});`;
await fs.writeFile(path.join(folder,'isolation.test.mjs'),source,{flag:'wx'});
try{
  const report=await checkProject(root,{project,kind:'test',entry:'isolation.test.mjs'},{probe:true});
  if(report.status!=='passed'||report.tests!==6||connections!==0)throw Error('Isolation probe failed: '+JSON.stringify({status:report.status,tests:report.tests,connections,stderr:report.stderr,stdout:report.stdout}));
  // A failing assertion must not be reported as a pass.
  await fs.writeFile(path.join(folder,'failure.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';test('intentional failure',()=>assert.equal(1,2));",{flag:'wx'});
  const failure=await checkProject(root,{project,kind:'test',entry:'failure.test.mjs'},{probe:true});if(failure.status!=='failed'||failure.exitCode===0)throw Error('Failed assertion was falsely certified.');
  await fs.writeFile(path.join(folder,'empty.mjs'),'export const value=1;',{flag:'wx'});
  const empty=await checkProject(root,{project,kind:'test',entry:'empty.mjs'},{probe:true});if(empty.status!=='failed'||empty.tests!==0)throw Error('Zero tests were falsely certified.');
  const syntax=await checkProject(root,{project,kind:'syntax',entry:'empty.mjs'},{probe:true});if(syntax.status!=='passed')throw Error('Syntax check failed.');
  await fs.writeFile(path.join(folder,'timeout.test.mjs'),'while(true){}',{flag:'wx'});
  const timeout=await checkProject(root,{project,kind:'test',entry:'timeout.test.mjs'},{probe:true,timeoutSeconds:2});if(timeout.status!=='failed'||timeout.exitCode!==124)throw Error('Run timeout was not enforced.');
  const evidence={owner:'home-ai-execution-probe-v1',passed:true,at:new Date().toISOString(),checks:6,connections,safetyRunId:report.id,failureRunId:failure.id,zeroTestsRunId:empty.id,syntaxRunId:syntax.id,timeoutRunId:timeout.id};
  await fs.writeFile(await safe(root,'state','execution-probe.json'),JSON.stringify(evidence,null,2));
  console.log('PASS: real imported app assertions, read-only snapshot, outside reads/child processes/network blocked, sanitized environment, failure and zero-test rejection, syntax checks and native timeout enforcement.');
}finally{await new Promise(r=>server.close(r));}
