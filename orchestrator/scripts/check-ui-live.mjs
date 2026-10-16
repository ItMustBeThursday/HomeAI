import { readFileSync } from 'node:fs';
const root='http://127.0.0.1:18850';
const token=readFileSync('D:/HomeAI/projects/orchestrator/data/token.txt','utf8').trim();
const headers={authorization:`Bearer ${token}`};
const get=async path=>{const r=await fetch(root+path,{headers,signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error(`${path}: HTTP ${r.status}`);return r;};
console.log('Health:',(await (await get('/api/health')).json()).ok);
const {files}=await(await get('/api/media')).json();
for(const name of ['cat_climb_FP16FP8_00001_.mp4','test_ace_turbo_00001.mp3','cat-climb-preview.png']) {
  const file=files.find(f=>f.name===name); if(!file)throw Error('Missing library example: '+name);
  const r=await get('/api/media/'+name);const bytes=(await r.arrayBuffer()).byteLength;
  if(bytes!==file.size)throw Error('Incorrect media size: '+name);
  console.log('Media response verified:',name,r.headers.get('content-type'),bytes);
}
const unauth=await fetch(root+'/api/media');if(unauth.status!==401)throw Error('Media auth failed');console.log('Unauthenticated library access refused: 401');
for(const path of ['/polish.css','/media-view.js']) console.log('Static asset served:',path,(await get(path)).status);
