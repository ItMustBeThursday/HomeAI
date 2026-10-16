import { copyFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const base='D:/HomeAI/runtime/comfyui/ComfyUI/output';
const dest='D:/HomeAI/projects/orchestrator/data/media';
mkdirSync(dest,{recursive:true});
for(const [folder,name] of [['video','cat_climb_FP16FP8_00001_.mp4'],['video','cat_climb_Q4_00001_.mp4'],['video','cat_climb_Q8_00001_.mp4'],['audio','test_ace_turbo_00001.mp3']]) {
  const src=`${base}/${folder}/${name}`,target=`${dest}/${name}`;
  if(!existsSync(src)) { console.log('Not found:',name); continue; }
  if(!existsSync(target)) copyFileSync(src,target);
  const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
  if(hash(src)!==hash(target)) throw Error('Copy verification failed: '+name);
  console.log('Verified library copy:',name);
}
const still='D:/HomeAI/tools/media/review_frames/frame_FP16FP8.png';
const preview=`${dest}/cat-climb-preview.png`;
if(existsSync(still)) {
  if(!existsSync(preview)) copyFileSync(still,preview);
  if(!readFileSync(still).equals(readFileSync(preview))) throw Error('Image copy verification failed');
  console.log('Verified library copy: cat-climb-preview.png (existing video still)');
}
