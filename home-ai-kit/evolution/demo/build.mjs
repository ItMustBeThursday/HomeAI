import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(here),dist=path.join(root,'dist');
const files=[['index.html',path.join(here,'index.html')],['app.mjs',path.join(here,'app.mjs')],['switch-core.mjs',path.join(root,'switch-core.mjs')]];
const data=await Promise.all(files.map(async([name,file])=>({name,bytes:await fs.readFile(file)})));
try{const s=await fs.lstat(dist);if(s.isSymbolicLink()||!s.isDirectory())throw Error('dist is not an ordinary directory');}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.mkdir(dist,{recursive:true});
for(const f of data){const dest=path.join(dist,f.name);try{const s=await fs.lstat(dest);if(s.isSymbolicLink()||s.nlink>1)throw Error('Linked output refused');}catch(e){if(e.code!=='ENOENT')throw e;}await fs.writeFile(dest,f.bytes);}
const manifest={builtAt:new Date().toISOString(),scope:'development switch simulator, no hardware control',files:data.map(f=>({name:f.name,bytes:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex')}))};
const manifestPath=path.join(dist,'build-manifest.json');
try{const s=await fs.lstat(manifestPath);if(s.isSymbolicLink()||s.nlink>1||!s.isFile())throw Error('Linked/non-file manifest refused');}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest));
