import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {withFileLock} from './lock.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const reserved=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export async function safe(root,...segments){
  const base=path.resolve(root),full=path.resolve(base,...segments);if(full!==base&&!full.startsWith(base+path.sep))throw Error('Execution path escapes its root.');
  let p=full;while(true){try{const s=await fs.lstat(p);if(s.isSymbolicLink()||(s.isFile()&&s.nlink>1))throw Error('Execution refuses linked paths.');}catch(e){if(e.code!=='ENOENT')throw e;}const parent=path.dirname(p);if(parent===p)break;p=parent;}return full;
}
function entryParts(entry){if(typeof entry!=='string'||entry.length>180)throw Error('Provide a relative JavaScript entry.');const parts=entry.split('/');if(parts.some(p=>!/^[-a-zA-Z0-9_.]+$/.test(p)||p==='..'||p==='.'||p.startsWith('.')||reserved.test(p)||p.endsWith('.'))||! /\.(js|mjs|cjs)$/.test(entry))throw Error('Unsafe JavaScript entry.');return parts;}
export async function snapshot(root,project,run){
  const base=await safe(root,'projects',project),input=path.join(run,'input');await fs.mkdir(input,{recursive:true});const files=[];let bytes=0,folders=0;
  async function walk(relative='',depth=0){
    if(depth>16||++folders>500)throw Error('Project snapshot exceeds its directory limit.');
    const folder=await safe(base,relative);
    for(const item of await fs.readdir(folder,{withFileTypes:true})){
      const rel=path.join(relative,item.name);const source=await safe(base,rel);
      if(item.isSymbolicLink())throw Error('Linked project input refused.');
      if(item.name.startsWith('.')||/^(node_modules|auth\.json|credentials.*)$/i.test(item.name))continue;
      // Offline checks snapshot source, never conventional generated build trees.
      // Keep this after safe()/link checks: even excluded directory links are refused.
      if(item.isDirectory()&&/^(build|dist)$/i.test(item.name))continue;
      if(reserved.test(item.name)||!/^[-a-zA-Z0-9_.]+$/.test(item.name)||item.name.endsWith('.'))throw Error('Unsafe snapshot filename.');
      if(item.isDirectory()){await walk(rel,depth+1);continue;}
      if(!/\.(js|mjs|cjs|json|html|css|md|txt|svg)$/i.test(item.name))continue;
      const info=await fs.stat(source);if(!info.isFile()||info.size>1024*1024)throw Error('Snapshot input exceeds its file limit.');
      const data=await fs.readFile(source);bytes+=data.length;if(bytes>10*1024*1024||files.length>=200)throw Error('Project snapshot exceeds 200 files or 10 MiB.');
      if(data.includes(0))throw Error('Binary input is not supported by the offline JavaScript runner.');
      const dest=await safe(input,rel);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,data,{flag:'wx'});
      files.push({file:rel.replaceAll('\\','/'),bytes:data.length,sha256:digest(data)});
    }
  }
  await walk();return files;
}
async function native(root,id){
  if(process.platform!=='win32')throw Error('This execution backend requires Windows.');
  const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=await safe(root,'scripts','Invoke-HomeAIIsolatedNode.ps1');
  await new Promise((resolve,reject)=>{
    const child=spawn(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Root',root,'-RunId',id],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let text='';const timer=setTimeout(()=>child.kill(),60000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{text=(text+b).slice(-8000);});
    child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',async()=>{clearTimeout(timer);try{await fs.stat(await safe(root,'state','execution','runs',id,'native-result.json'));resolve();}catch{reject(Error('Isolated launcher did not produce an execution result. '+text.slice(-2000)));}});
  });
}
export async function checkProject(root,p,options={}){
  if(typeof p.project!=='string'||! /^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.project)||reserved.test(p.project))throw Error('Invalid project name.');
  if(options.projectScope&&p.project!==options.projectScope)throw Error('This worker can check only its assigned project.');
  if(!['test','syntax'].includes(p.kind))throw Error('Choose test or syntax.');entryParts(p.entry);
  const settings=JSON.parse(await fs.readFile(await safe(root,'homeai.json'),'utf8'));
  if(settings.owner!=='home-ai-kit-v1'||path.resolve(settings.root)!==path.resolve(root))throw Error('HomeAI ownership differs.');
  const marker=JSON.parse(await fs.readFile(await safe(root,'state','execution-connector.json'),'utf8'));
  if(marker.owner!=='home-ai-execution-v1'||(!marker.enabled&&!options.probe))throw Error('Enable-HomeAIExecution.ps1 must pass isolation checks first.');
  const lock=await safe(root,'state','execution','runner.lock');
  return withFileLock(lock,async()=>{
    const id=randomUUID(),run=await safe(root,'state','execution','runs',id);await fs.mkdir(run,{recursive:true});
    const files=await snapshot(root,p.project,run);const entry=files.find(f=>f.file===p.entry);
    if(!entry)throw Error('Requested entry is absent from the snapshot.');
    const timeoutSeconds=options.timeoutSeconds??30;if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<2||timeoutSeconds>30)throw Error('Invalid execution time budget.');
    const request={owner:'home-ai-execution-request-v1',id,project:p.project,entry:p.entry,kind:p.kind,timeoutSeconds,jobId:options.jobId||null,createdAt:new Date().toISOString(),files};
    await fs.writeFile(path.join(run,'request.json'),JSON.stringify(request,null,2),{flag:'wx'});
    await (options.launch||native)(root,id);
    const result=JSON.parse(await fs.readFile(await safe(run,'native-result.json'),'utf8'));
    if(result.owner!=='home-ai-native-execution-v1'||result.id!==id||result.isolation!=='windows-appcontainer-no-capabilities'||result.nodePermission!==true||!Number.isInteger(result.exitCode))throw Error('Unexpected native result ownership or isolation.');
    const read=async name=>{const file=await safe(run,name);const stat=await fs.stat(file);if(stat.size>2*1024*1024)throw Error('Execution log exceeded its bound.');return fs.readFile(file,'utf8');};
    const stdout=await read('stdout.txt'),stderr=await read('stderr.txt');
    const count=name=>{const values=[...stdout.matchAll(new RegExp('^# '+name+' (\\d+)\\s*$','gm'))];return values.length?Number(values.at(-1)[1]):0;};
    const subtests=[...stdout.matchAll(/^# Subtest: (.+)\s*$/gm)].map(m=>m[1].trim());
    const fileOnly=subtests.length===1&&[p.entry,path.basename(p.entry),path.join(run,'input',p.entry)].includes(subtests[0]);
    const tests=fileOnly?0:count('tests'),passedTests=fileOnly?0:count('pass');
    const changed=[];
    for(const file of files){const original=await safe(root,'projects',p.project,...file.file.split('/'));try{if(digest(await fs.readFile(original))!==file.sha256)changed.push(file.file);}catch{changed.push(file.file);}}
    const passed=result.exitCode===0&&(p.kind==='syntax'||tests>0&&passedTests>0);
    const report={owner:'home-ai-execution-report-v1',id,project:p.project,kind:p.kind,entry:p.entry,jobId:options.jobId||null,status:passed?'passed':'failed',exitCode:result.exitCode,tests,passedTests,sourceHashes:files,sourceChangedAfterSnapshot:changed,isolation:result.isolation,finishedAt:result.finishedAt,stdout:stdout.slice(-16000),stderr:stderr.slice(-8000),scope:'This checks the copied snapshot only. Generated tests require review; passing tests do not certify complete application behavior.'};
    await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});
    return report;
  });
}
