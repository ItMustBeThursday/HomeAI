import assert from 'node:assert/strict';
import {runNative, parseCodexResult} from '../home-ai-kit/run-native.mjs';

const prompt = 'Unicode: café 🦊; literal $(do-not-run) `quotes` "hello"\nSecond line';
const echo = await runNative({executable:process.execPath, args:['-e', 'process.stdin.pipe(process.stdout)'], cwd:process.cwd(), input:prompt});
assert.equal(echo.code, 0); assert.equal(echo.stdout, prompt);
const reply = JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'A successful discussion of usage limits'}})+'\n'+JSON.stringify({type:'turn.completed'});
assert.deepEqual(parseCodexResult({code:0,stdout:reply,stderr:''}), {success:true,limited:false,answer:'A successful discussion of usage limits',reason:'completed'});
const limited = parseCodexResult({code:1,stdout:JSON.stringify({type:'turn.failed',error:{code:'usage_limit_reached'}}),stderr:''});
assert.equal(limited.limited, true); assert.equal(limited.success, false);
assert.equal(parseCodexResult({code:0,stdout:reply.split('\n')[0],stderr:''}).success,false);
assert.equal(parseCodexResult({code:1,stdout:reply,stderr:'launch failure'}).limited,false);
const timeout = await runNative({executable:process.execPath,args:['-e','setTimeout(()=>{},3000)'],cwd:process.cwd(),timeoutSeconds:0.05});
assert.equal(timeout.timedOut,true); assert.notEqual(timeout.code,0);
console.log('PASS: UTF-8 stdin, shell metacharacters remain literal, completed-turn requirement, quota classification, ordinary failure, timeout.');
