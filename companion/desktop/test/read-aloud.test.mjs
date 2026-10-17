import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadAloud} from '../src/renderer/read-aloud.mjs';

function fixture() {
  const utterances=[], states=[], errors=[];
  let cancels=0;
  const synthesis={speak:u=>utterances.push(u),cancel:()=>cancels++};
  class Utterance { constructor(text) { this.text=text; } }
  const reader=createReadAloud({synthesis,Utterance,onState:s=>states.push(s),onError:e=>errors.push(e)});
  return {reader,synthesis,utterances,states,errors,get cancels(){return cancels;}};
}
test('unsupported platform reports failure without throwing',()=>{
  const errors=[];
  const reader=createReadAloud({onError:e=>errors.push(e)});
  assert.equal(reader.supported,false);
  assert.equal(reader.speak('Hello'),false);
  reader.stop();
  assert.equal(errors.length,1);
});
test('nothing speaks automatically and empty responses are ignored',()=>{
  const f=fixture();assert.equal(f.utterances.length,0);
  assert.equal(f.reader.speak('  '),false);assert.equal(f.reader.speaking,false);
});
test('long responses preserve text and queue one short utterance at a time',()=>{
  const f=fixture(),text=('A sentence with spaces.\n').repeat(100)+'end';
  f.reader.speak(text);assert.equal(f.utterances.length,1);
  for(let i=0;i<f.utterances.length;i++){
    assert.ok(f.utterances[i].text.length<=241);
    f.utterances[i].onend();
  }
  assert.equal(f.utterances.map(u=>u.text).join(''),text);
  assert.equal(f.reader.speaking,false);
  assert.equal(f.states.at(-1),false);
});
test('stop invalidates delayed callbacks and prevents queued text from resuming',()=>{
  const f=fixture();f.reader.speak('hello '.repeat(200));const old=f.utterances[0];
  f.reader.stop();old.onend();old.onerror({error:'interrupted'});
  assert.equal(f.utterances.length,1);assert.equal(f.reader.speaking,false);assert.equal(f.errors.length,0);
});
test('replacement response cannot be stopped by stale platform callbacks',()=>{
  const f=fixture();f.reader.speak('first');const old=f.utterances[0];f.reader.speak('second');
  old.onerror({error:'canceled'});old.onend();
  assert.equal(f.reader.speaking,true);assert.equal(f.errors.length,0);
  f.utterances[1].onend();assert.equal(f.reader.speaking,false);
});
test('synchronous cancel callbacks do not surface errors',()=>{
  const f=fixture();f.reader.speak('first');
  f.synthesis.cancel=()=>f.utterances[0].onerror({error:'canceled'});
  f.reader.stop();assert.equal(f.errors.length,0);
});
test('platform error clears state and permits retry',()=>{
  const f=fixture();f.reader.speak('hello');f.utterances[0].onerror({error:'voice-unavailable'});
  assert.equal(f.reader.speaking,false);assert.equal(f.errors.length,1);
  assert.equal(f.reader.speak('retry'),true);
});
test('platform exception is contained with an actionable error',()=>{
  const f=fixture();f.synthesis.speak=()=>{throw new Error('engine failed');};
  assert.equal(f.reader.speak('hello'),false);assert.equal(f.reader.speaking,false);assert.equal(f.errors.length,1);
});
