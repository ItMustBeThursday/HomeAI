import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchBudget} from '../home-ai-kit/jobs-plugin/dispatch-budget.mjs';
test('default permits an ordinary long coding turn and watchdog outlives its CLI',()=>{const b=dispatchBudget(); assert.equal(b.agentTimeoutSeconds,900); assert.ok(b.watchdogMs>b.agentTimeoutSeconds*1000); assert.ok(b.watchdogMs-b.agentTimeoutSeconds*1000>=30000); assert.ok(Object.isFrozen(b));});
test('explicit bounded deadline remains coherent at both supported limits',()=>{for(const seconds of [60,600,3600]) {const b=dispatchBudget({workerTurnTimeoutSeconds:seconds}); assert.equal(b.agentTimeoutSeconds,seconds); assert.ok(b.watchdogMs>seconds*1000);}});
test('bad settings cannot disable the watchdog or supply unbounded durations',()=>{for(const v of [0,-1,59,3601,Infinity,NaN,'900',true,{},900.5])assert.throws(()=>dispatchBudget({workerTurnTimeoutSeconds:v}),RangeError);});
