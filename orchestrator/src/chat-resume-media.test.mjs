import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConversationStore,buildPrompt} from './history.mjs';
import {createOrchestrator} from './orchestrator.mjs';
import {mediaIntent} from './media-intent.mjs';
import {createAutoRouter} from './autoroute.mjs';
const config={connectors:{text:{kind:'ollama',model:'text'},agent:{kind:'codex-cli',model:'code'},v:{kind:'comfyui',model:'Wan',media:'video'},a:{kind:'comfyui',model:'ACE',media:'audio'},i:{kind:'comfyui',model:'SDXL',media:'image'}},routes:{general:{chain:['text']},agent:{chain:['agent'],agent:true},video:{chain:['v']},music:{chain:['a']},image:{chain:['i']}},default:'general',auto:{chat:'general',act:'agent'}};
const store=()=>createConversationStore(mkdtempSync(join(tmpdir(),'resume-media-')));
const ok={ok:true,text:'done'};
test('an executing request and activity are durable before the model finishes',async()=>{
 const s=store(); let release,id;
 const o=createOrchestrator({config,conversations:s,run:async(e,{onEvent})=>{onEvent({type:'tool',name:'Edit',summary:'changed app.js'}); await new Promise(r=>release=r);return ok;}});
 const pending=o.chat({prompt:'finish the project',onEvent:e=>{if(e.type==='conversation')id=e.id;}});
 assert.equal(s.get(id).messages[0].text,'finish the project');
 assert.equal(s.get(id).run.status,'running');assert.match(s.get(id).run.progress.at(-1),/changed app.js/);
 await assert.rejects(o.chat({conversationId:id,prompt:'duplicate'}),/already running/);
 release();await pending;assert.equal(s.get(id).run.status,'complete');assert.equal(s.get(id).messages.length,2);
});
test('restart marks interruption, preserves progress, and a different model receives it',async()=>{
 const s=store(),c=s.create({taskType:'general'});
 s.begin(c.id,{role:'user',text:'implement native video chat'},{route:'general',prompt:'implement native video chat'});
 s.progress(c.id,{type:'tool',name:'Edit',summary:'video endpoint added'});
 assert.equal(s.recoverInterrupted(),1);assert.equal(s.recoverInterrupted(),0);
 let p;const o=createOrchestrator({config,conversations:s,run:async(e,a)=>(p=a.prompt,ok)});
 await o.chat({conversationId:c.id,prompt:'please resume'});
 assert.match(p,/implement native video chat/);assert.match(p,/video endpoint added/);
});
test('long assistant output cannot erase the original task on resume',()=>{
 const p=buildPrompt([{role:'user',text:'Integrate video, music and images in chat'},{role:'assistant',text:'x'.repeat(20000)}],'please resume');
 assert.match(p,/Integrate video, music and images/);assert.match(p,/please resume/);
});

test('a fresh store recovers a running chat from disk exactly once across restarts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'resume-reopen-'));
 const first=createConversationStore(dir),c=first.create({title:'Keep my chat'});
 first.append(c.id,{role:'user',text:'original task'},{role:'assistant',text:'earlier reply',files:[{name:'clip.mp4'}]});
 first.begin(c.id,{role:'user',text:'continue the task'},{route:'general',prompt:'continue the task',runId:'saved-run'});
 first.progress(c.id,{type:'tool',name:'Edit',summary:'partial work saved'});
 const restarted=createConversationStore(dir);
 assert.equal(restarted.recoverInterrupted(),1);
 const again=createConversationStore(dir);
 assert.equal(again.recoverInterrupted(),0);
 const saved=again.get(c.id);
 assert.equal(saved.title,'Keep my chat');
 assert.equal(saved.messages.length,4);
 assert.equal(saved.messages[1].files[0].name,'clip.mp4');
 assert.equal(saved.run.runId,'saved-run');
 assert.match(saved.run.progress[0],/partial work saved/);
 assert.equal(saved.run.status,'interrupted');
});
test('explicit media requests bypass a text pin and pass only the scene and settings',async()=>{
 for(const [prompt,route,connector] of [['Generate a video of a cat climbing a wall','video','v'],['Create music with gentle piano','music','a'],['Generate an image of a red fox','image','i'],['draw a cat','image','i']]){
  const s=store();let actual;
  const o=createOrchestrator({config,conversations:s,run:async(e,a)=>(actual={e,a},{...ok,files:[{name:'output.png',kind:'png'}]})});
  const result=await o.chat({prompt,connector:'text',params:{steps:4}});
  assert.equal(result.reply.connector,connector);assert.equal(result.reply.taskType,route);
  assert.equal(actual.a.prompt,prompt);assert.equal(actual.e.params.steps,4);
  assert.equal(s.get(result.conversation.id).messages[1].files[0].name,'output.png');
 }
});
test('media questions and prompt-writing requests remain text; chat devices can generate',async()=>{
 for(const p of ['Tell me about video models','Write a prompt for an image','Can you explain music generation?','Fix image generation in app.js']) assert.equal(mediaIntent(p,config),null);
 const decide=createAutoRouter({getConfig:()=>config,run:()=>{throw Error('must not classify')}});
 assert.equal((await decide({prompt:'generate an image of a fox',canAct:false})).route,'image');
});
test('interrupted media resumes the saved scene rather than generating a resume message',async()=>{
 const s=store(),c=s.create();s.begin(c.id,{role:'user',text:'Make a video of a cat'},{route:'video',prompt:'Make a video of a cat',mediaPrompt:'A cat climbing a wall'});s.recoverInterrupted();
 let actual;const o=createOrchestrator({config,conversations:s,run:async(e,a)=>(actual={e,a},ok)});
 await o.chat({conversationId:c.id,prompt:'Please resume the interrupted task',connector:'text'});
 assert.equal(actual.e.connector,'v');assert.match(actual.a.prompt,/cat climbing a wall/);assert.doesNotMatch(actual.a.prompt,/Conversation so far/);
});
