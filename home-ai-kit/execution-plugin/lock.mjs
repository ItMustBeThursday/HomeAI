import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
export async function withFileLock(file,action){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const nonce=randomUUID();let handle;
  for(let attempt=0;attempt<300;attempt++){
    try{handle=await fs.open(file,'wx');await handle.writeFile(JSON.stringify({owner:'home-ai-file-lock-v1',pid:process.pid,nonce}));break;}
    catch(error){if(error.code!=='EEXIST')throw error;
      try{const text=await fs.readFile(file,'utf8'),lock=JSON.parse(text);
        if(lock.owner==='home-ai-file-lock-v1'&&Number.isInteger(lock.pid)){
          let alive=true;try{process.kill(lock.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
          if(!alive&&(await fs.readFile(file,'utf8'))===text)await fs.unlink(file);
        }
      }catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
      await new Promise(r=>setTimeout(r,100));
    }
  }
  if(!handle)throw Error('Project file is busy; retry after its current operation settles.');
  try{return await action();}finally{await handle.close();try{const lock=JSON.parse(await fs.readFile(file,'utf8'));if(lock.nonce===nonce)await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
