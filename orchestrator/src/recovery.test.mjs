import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from './orchestrator.mjs';
import { createConversationStore } from './history.mjs';
import { localMediaName } from '../web/media-view.js';
const config = {connectors:{a:{kind:'claude-cli',model:'a'},b:{kind:'codex-cli',model:'b'}},routes:{agent:{chain:['a','b'],agent:true}},default:'agent'};
const ok = {ok:true,text:'done',inputTokens:1,outputTokens:1};
test('preferred models run despite zero local caps',async()=>{
  const used=[],events=[];
  const o=createOrchestrator({config,caps:{caps:{perConnector:{a:{calls:0}}}},run:async e=>(used.push(e.connector),ok)});
  const r=await o.task({prompt:'work',cwd:'D:/work',connector:'a',onEvent:e=>events.push(e)});
  assert.equal(r.ok,true); assert.deepEqual(used,['a']); assert.equal(r.attempts[0].ok,true);
  assert.equal(events[0].type,'attempt');
});
test('preferred execution failure uses only compatible configured alternatives',async()=>{
  const used=[];
  const c=structuredClone(config); c.connectors.chat={kind:'ollama',model:'chat'}; c.routes.agent.chain=['a','chat','b'];
  const o=createOrchestrator({config:c,run:async e=>(used.push(e.connector),e.connector==='a'?{ok:false,error:'exit 1'}:ok)});
  assert.equal((await o.task({prompt:'work',cwd:'D:/work',connector:'a'})).connector,'b');
  assert.deepEqual(used,['a','b']);
});
test('provider failures retain recovery information despite zero local caps',async()=>{
  const conversations=createConversationStore(mkdtempSync(join(tmpdir(),'recovery-')));
  const o=createOrchestrator({config,conversations,caps:{caps:{perTaskType:{agent:{calls:0}}}},run:async()=>{throw Error('provider unavailable')}});
  const r=await o.chat({prompt:'preserve this task',cwd:'D:/work',connector:'a'});
  assert.equal(r.reply.ok,false); assert.equal(r.reply.code,'connectors_failed');
  assert.equal(r.reply.recovery.resetAt,undefined); assert.match(r.reply.text,/saved/);
  const messages=conversations.get(r.conversation.id).messages;
  assert.equal(messages[0].text,'preserve this task'); assert.equal(messages[1].attempts.length,2);
  assert.equal(messages[1].text,r.reply.text);
});
test('cancellation never triggers preferred-model fallback',async()=>{
  const used=[];
  const o=createOrchestrator({config,run:async e=>(used.push(e.connector),{ok:false,error:'Cancelled',cancelled:true})});
  const r=await o.task({prompt:'work',cwd:'D:/work',connector:'a'});
  assert.equal(r.cancelled,true); assert.deepEqual(used,['a']);
});
test('media fallback stays within the same modality and files survive chat reloads',async()=>{
  const c={connectors:{v:{kind:'comfyui',model:'video',media:'video'},a:{kind:'comfyui',model:'music',media:'audio'},v2:{kind:'comfyui',model:'video2',media:'video'}},routes:{video:{chain:['v','a','v2']}},default:'video'};
  const conversations=createConversationStore(mkdtempSync(join(tmpdir(),'media-chat-'))),used=[];
  const o=createOrchestrator({config:c,conversations,run:async e=>(used.push(e.connector),e.connector==='v'?{ok:false,error:'unavailable'}:{...ok,files:[{name:'test.mp4',kind:'video'}]})});
  const r=await o.chat({prompt:'make a video',connector:'v'});
  assert.deepEqual(used,['v','v2']); assert.equal(conversations.get(r.conversation.id).messages[1].files[0].name,'test.mp4');
});
test('inline media accepts only local filenames and supported media types',()=>{
  for(const value of ['clip.mp4','/api/media/clip.mp4','song.mp3','picture.webp']) assert.ok(localMediaName(value));
  for(const value of ['../token.txt','/api/media/../secret.png','https://remote/track.mp4','javascript:alert(1)','/api/media/x.svg','x.mp4?token=secret','']) assert.equal(localMediaName(value),null);
});
