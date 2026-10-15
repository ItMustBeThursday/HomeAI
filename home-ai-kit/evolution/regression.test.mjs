// Review-driven regressions; no sockets, processes, writes or fake hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSwitchController} from './switch-core.mjs';
import {createVoiceSession} from './voice-core.mjs';
import {rankCandidates} from './model-policy.mjs';
const config={deviceIds:['a','b'],itemIds:['music','quiet'],mode:'one',debounceMs:10,scanIntervalMs:1000,maxAgeMs:2000};
const event=(kind,at,extra={})=>({kind,at,receivedAt:at,deviceId:'a',sessionId:'A',seq:0,...extra});
test('review: retired session A-B-A cannot replay or select',()=>{
  const c=createSwitchController(config);
  c.handle(event('connect',0));
  c.handle(event('connect',1,{sessionId:'B'}));
  const before=c.snapshot();
  assert.deepEqual(c.handle(event('connect',2)),[{type:'reject',reason:'retired-session'}]);
  assert.deepEqual(c.handle(event('press',2,{button:1,seq:1})),[{type:'reject',reason:'retired-session'}]);
  assert.deepEqual(c.snapshot(),before);
});
test('review: first tick advances once; early ticks do nothing and late ticks do not catch up',()=>{
  const c=createSwitchController(config);
  const highlighted=[{type:'highlight',index:1,itemId:'quiet'},{type:'feedback',action:'highlight',itemId:'quiet'}];
  assert.deepEqual(c.handle(event('tick',100)),highlighted);
  assert.deepEqual(c.handle(event('tick',1099)),[]);
  assert.deepEqual(c.handle(event('tick',10000)),[{type:'highlight',index:0,itemId:'music'},{type:'feedback',action:'highlight',itemId:'music'}]);
});
test('review: equal hub timestamps allow increasing sequence; cross-device backward timestamps reject',()=>{
  const c=createSwitchController(config);
  c.handle(event('connect',100));
  assert.deepEqual(c.handle(event('press',100,{seq:1,button:1})),[
    {type:'select',index:0,itemId:'music',deviceId:'a'},
    {type:'feedback',action:'select',itemId:'music'}
  ]);
  assert.deepEqual(c.handle(event('connect',99,{deviceId:'b',sessionId:'B'})),[{type:'reject',reason:'non-monotonic'}]);
  assert.deepEqual(c.handle(event('tick',99)),[{type:'reject',reason:'non-monotonic'}]);
  assert.deepEqual(c.handle(event('connect',101,{deviceId:'b',sessionId:'B',receivedAt:100})),[{type:'reject',reason:'future'}]);
});
test('review: voice request memory is bounded without re-enabling retired IDs',()=>{
  const c=createVoiceSession({maxRequests:2});
  assert.deepEqual(c.handle({type:'start',requestId:'A'}),[{type:'capture',requestId:'A'}]);
  assert.deepEqual(c.handle({type:'start',requestId:'B'}),[{type:'stop',requestId:'A'},{type:'capture',requestId:'B'}]);
  assert.deepEqual(c.handle({type:'start',requestId:'C'}),[{type:'reject',reason:'session-capacity'}]);
  assert.deepEqual(c.handle({type:'start',requestId:'A'}),[{type:'reject',reason:'reused-request-id'}]);
  assert.deepEqual(c.snapshot(),{state:'listening',requestId:'B',textFallbackAvailable:true});
  assert.deepEqual(c.handle({type:'response',requestId:'A',text:'stale'}),[{type:'reject',reason:'stale-request'}]);
  for(const maxRequests of [0,-1,65537,Infinity])assert.throws(()=>createVoiceSession({maxRequests}),TypeError);
});
test('review: hosted candidates need no invented VRAM, local candidates still require measured VRAM',()=>{
  const base={id:'hosted',local:false,status:'admitted',digest:'a'.repeat(64),roles:['coding'],contextTokens:100,maxOutputTokens:50,quality:0.9,latencyMs:20};
  const req={role:'coding',inputTokens:20,outputTokens:20,minQuality:0.8,maxLatencyMs:100,reserveVramBytes:100};
  assert.deepEqual(rankCandidates([base,{...base,id:'local',local:true}],req,0).map(x=>x.id),['hosted']);
  for(const field of ['quality','latencyMs','digest','contextTokens']){
    const unknown={...base}; delete unknown[field];
    assert.deepEqual(rankCandidates([unknown],req,0),[]);
  }
});
