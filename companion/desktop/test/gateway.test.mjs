import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {GatewayClient,createIdentity,signPayload,assertAllowedUrl,parseSetupCode} from '../src/core/gateway-client.mjs';
const make=()=>new GatewayClient({store:{loadConnection:async()=>({url:'ws://localhost:1234'}),loadIdentity:async()=>createIdentity()},client:{id:'webchat',mode:'ui',platform:'windows',deviceFamily:'desktop'}});
test('identity signatures verify with generated public key',()=>{const id=createIdentity();const key=crypto.createPublicKey(id.privateKeyPem);assert(crypto.verify(null,Buffer.from('challenge'),key,Buffer.from(signPayload(id.privateKeyPem,'challenge'),'base64url')));assert.equal(id.deviceId.length,64);});
test('public plaintext rejected and secure remote allowed',()=>{assert.throws(()=>assertAllowedUrl('ws://example.com'));assert.throws(()=>assertAllowedUrl('https://example.com'));assertAllowedUrl('wss://example.com/companion');assertAllowedUrl('ws://127.0.0.1:1234');});
test('setup expiry rejected',()=>{const code=Buffer.from(JSON.stringify({url:'wss://example.com',bootstrapToken:'test',expiresAtMs:20})).toString('base64url');assert.throws(()=>parseSetupCode(code,21),/expired/);assert.equal(parseSetupCode(code,10).bootstrapToken,'test');});
test('heartbeat timeout transitions offline and schedules retry',async()=>{const g=make();g.stopped=false;g.identity=async()=>createIdentity();g.rawRequest=async()=>({ok:true,payload:{policy:{tickIntervalMs:5}}});let retry=false;g.scheduleRetry=()=>{retry=true;};await g.handshake({url:'wss://example.com',deviceToken:'test'},{ts:Date.now(),nonce:'n'});g.lastFrameAt=0;await new Promise(r=>setTimeout(r,20));assert.equal(g.state,'offline');assert.equal(retry,true);g.stop();});
test('pairing schedules retry even if server does not close socket',async()=>{const g=make();let delay;g.scheduleRetry=ms=>{delay=ms;};await g.onConnectError({},{code:'NOT_PAIRED',details:{requestId:'test'}},createIdentity());assert.equal(g.state,'pairing');assert.equal(delay,5000);g.stop();});
test('stop during storage read prevents a new socket',async()=>{let release;const g=make();g.store.loadConnection=()=>new Promise(r=>{release=r;});let connects=0;g.connect=()=>connects++;const started=g.start();g.stop();release({url:'ws://localhost:1234'});await started;assert.equal(connects,0);});
test('teardown rejects pending requests immediately',async()=>{const g=make();g.ws={readyState:1,send(){},close(){}};const pending=g.rawRequest('chat.history',{});g.teardown(1000,'test');await assert.rejects(pending,/closed/);assert.equal(g.pending.size,0);});

test('bootstrap signature binds the actual setup credential, nonce and client metadata',async()=>{
 const identity=createIdentity(),g=make();g.store.loadIdentity=async()=>identity;
 g.client={id:'openclaw-android',mode:'ui',platform:'android',deviceFamily:'android'};
 let sent;
 g.rawRequest=async(method,params)=>{sent=params;return {ok:false,error:{code:'NOT_PAIRED',details:{requestId:'test'}}};};
 g.scheduleRetry=()=>{};
 await g.handshake({url:'wss://example.com/companion',bootstrapToken:'regression-bootstrap-token'},{ts:1792070000000,nonce:'unique-challenge'});
 assert.equal(sent.auth.bootstrapToken,'regression-bootstrap-token');
 assert.equal(sent.role,'node');assert.deepEqual(sent.scopes,[]);
 const expected=['v3',identity.deviceId,'openclaw-android','node','node','','1792070000000','regression-bootstrap-token','unique-challenge','android','android'].join('|');
 const signature=Buffer.from(sent.device.signature,'base64url'),key=crypto.createPublicKey(identity.privateKeyPem);
 assert(crypto.verify(null,Buffer.from(expected),key,signature));
 assert(!crypto.verify(null,Buffer.from(expected.replace('regression-bootstrap-token','')),key,signature));
 assert(!crypto.verify(null,Buffer.from(expected.replace('unique-challenge','replayed')),key,signature));
 g.stop();
});
