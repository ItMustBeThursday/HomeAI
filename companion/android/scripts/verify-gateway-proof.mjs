import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Uses the installed server verifier, not a copied implementation. Inputs are
// synthetic RFC 8032 test identity material emitted by the real JVM proof tests.
const dist=process.argv[2]??'D:/HomeAI/runtime/openclaw/node_modules/openclaw/dist';
const {l:resolveVersion}=await import(pathToFileURL(path.join(dist,'node-connect-reconcile-CV2jR04R.mjs')));
for(const name of ['bootstrap','operator']){
 const fixture=JSON.parse(await readFile(new URL('../app/build/reports/'+name+'-proof.json',import.meta.url),'utf8'));
 assert.equal(resolveVersion(fixture),'v3',name+' JVM signature must verify on installed Gateway');
 const changed=structuredClone(fixture);changed.nonce='different-nonce';
 assert.equal(resolveVersion(changed),null,'nonce substitution must fail');
 const wrongCredential=structuredClone(fixture);
 wrongCredential.connectParams.auth[name==='bootstrap'?'bootstrapToken':'token']='different-credential';
 assert.equal(resolveVersion(wrongCredential),null,'credential substitution must fail');
 if(name==='bootstrap'){
  const omitted=structuredClone(fixture);omitted.connectParams.auth.bootstrapToken='';
  assert.equal(resolveVersion(omitted),null,'old empty-credential bootstrap proof must fail');
 }
}
console.log('PASS: JVM bootstrap/operator Ed25519 proofs accepted by installed Gateway v3 verifier; 5 tampering/omission checks rejected.');
