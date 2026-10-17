// Local-only acceptance against the real voice service and current HTTP adapter.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../src/server.mjs';
import { createVoice } from '../src/voice.mjs';
import { createOrchestrator } from '../src/orchestrator.mjs';
import { createConversationStore, createTaskHistory } from '../src/history.mjs';

const dir = `D:/HomeAI/evaluations/voice-${Date.now()}`;
mkdirSync(dir, { recursive: true });
const token = randomUUID();
const config = {connectors:{local:{kind:'ollama',model:'unused'}},routes:{general:{chain:['local']}},default:'general'};
const conversations = createConversationStore(join(dir,'conversations'));
const orchestrator = createOrchestrator({config,conversations,history:createTaskHistory(join(dir,'history.jsonl')),run:async()=>{throw Error('No LLM calls in voice acceptance');}});
const server = await startServer({orchestrator,conversations,token,webDir:'D:/HomeAI/projects/orchestrator/web',voice:createVoice()}, {port:0});
const base = `http://127.0.0.1:${server.address().port}`;
const report = {dir,checks:[],timings:{}};
async function request(path,init={}) {
  const r = await fetch(base+path,{...init,headers:{authorization:`Bearer ${token}`,...init.headers},signal:AbortSignal.timeout(600_000)});
  if (!r.ok) throw Error(`${path}: ${r.status}: ${await r.text()}`);
  return r;
}
async function synth(text,voice,file) {
  const t=Date.now();
  const r=await request('/api/voice/tts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,voice})});
  const wav=Buffer.from(await r.arrayBuffer());
  assert.equal(wav.toString('ascii',0,4),'RIFF'); assert.equal(wav.toString('ascii',8,12),'WAVE'); assert.ok(wav.length>10000);
  writeFileSync(join(dir,file),wav); report.timings[file]=(Date.now()-t)/1000; return wav;
}
try {
  assert.equal((await fetch(base+'/api/voice/status')).status,401); report.checks.push('authentication');
  assert.equal((await (await request('/api/voice/status')).json()).available,true);
  const voices=await (await request('/api/voice/voices')).json(); assert.ok(voices.builtin.includes('af_heart')); report.builtinVoices=voices.builtin.length;
  const text='Hello Adam. Voice recognition and natural speech are running locally on this computer. We can have a conversation using the microphone.';
  const wav=await synth(text,'af_heart','natural.wav'); report.checks.push('natural TTS produces WAV');
  const stt=await (await request('/api/voice/stt?lang=en',{method:'POST',body:wav})).json();
  report.recognized=stt; assert.match(stt.text,/hello[, ]+adam/i); assert.match(stt.text,/microphone/i); report.checks.push('TTS to STT roundtrip');
  const name='acceptance-'+Date.now(); report.syntheticClone=name;
  await request('/api/voice/clone/'+name,{method:'POST',body:wav});
  const cloning=synth('Hello Adam. This is a locally cloned test voice.','clone:'+name,'cloned.wav');
  await new Promise(r=>setTimeout(r,1500));
  const ht=Date.now(); await request('/api/voice/status'); report.healthDuringCloneMs=Date.now()-ht;
  assert.ok(report.healthDuringCloneMs<5000); await cloning; report.checks.push('clone synthesis and responsive health');
  const clonedStt=await (await request('/api/voice/stt?lang=en',{method:'POST',body:readFileSync(join(dir,'cloned.wav'))})).json();
  report.cloneRecognized=clonedStt; assert.match(clonedStt.text,/hello[, ]+adam/i); report.checks.push('cloned speech intelligibility');
  const invalid=await fetch(base+'/api/voice/stt',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'invalid'}); assert.equal(invalid.status,400); report.checks.push('invalid audio is 400');
  report.ok=true;
} catch(e) {report.ok=false;report.error=e.message;process.exitCode=1;}
finally {writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));server.close();}
