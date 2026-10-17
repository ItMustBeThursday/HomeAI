import {app,BrowserWindow,ipcMain,safeStorage,dialog,shell,Menu,desktopCapturer,screen} from 'electron';
import crypto from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {GatewayClient,newSessionKey,parseSetupCode} from '../core/gateway-client.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL='wss://coolermaster.tailbeae5b.ts.net:8443/companion';
let win,client;
const lock=app.requestSingleInstanceLock();
if(!lock)app.quit();
app.on('second-instance',()=>{win?.show();win?.focus();});
async function load(name){try{return JSON.parse(safeStorage.decryptString(await readFile(path.join(app.getPath('userData'),name+'.bin'))));}catch(e){if(e.code==='ENOENT')return null;throw new Error('Unable to unlock saved credentials. Use the same Windows account.');}}
async function save(name,value){if(!safeStorage.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable.');await mkdir(app.getPath('userData'),{recursive:true});await writeFile(path.join(app.getPath('userData'),name+'.bin'),safeStorage.encryptString(JSON.stringify(value)));}
const text=(s,max=100000)=>{if(typeof s!=='string'||s.length>max)throw new Error('Invalid input');return s;};
function emit(type,payload){if(win&&!win.isDestroyed())win.webContents.send('homeai:event',{type,payload});}
function status(){return {state:client.state,detail:client.detail,defaultUrl:DEFAULT_URL,capabilities:{captureScreen:true,attachments:true}};}
async function importFamilyCredentials(){
 if(await load('provisioned')||await load('identity')||await load('connection'))return;
 const file=path.join(app.isPackaged?process.resourcesPath:path.join(here,'../../resources'),'family-connection.json');
 let family;try{family=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return;throw new Error('Family connection package is invalid.');}
 const identity=family.identity;
 if(family.url!==DEFAULT_URL||typeof family.deviceToken!=='string'||!identity?.privateKeyPem)throw new Error('Family connection package is invalid.');
 const raw=crypto.createPublicKey(identity.privateKeyPem).export({format:'der',type:'spki'}).subarray(-32);
 if(identity.publicKey!==raw.toString('base64url')||identity.deviceId!==crypto.createHash('sha256').update(raw).digest('hex'))throw new Error('Family identity does not match.');
 await save('identity',identity);await save('connection',{url:family.url,deviceToken:family.deviceToken});await save('provisioned',true);
}
function attachments(items){
 if(items===undefined)return undefined;
 if(!Array.isArray(items)||items.length>8)throw new Error('Choose at most 8 attachments.');
 let bytes=0;
 return items.map(a=>{if(!a||!['image','file','audio'].includes(a.type)||typeof a.content!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(a.content))throw new Error('Invalid attachment.');
 const size=Buffer.from(a.content,'base64').length;bytes+=size;if(bytes>5*1024*1024)throw new Error('Attachments exceed the 5 MB limit.');
 return {type:a.type,mimeType:text(a.mimeType,128),fileName:text(a.fileName,240),content:a.content,sizeBytes:size};});
}
if(lock)app.whenReady().then(async()=>{
 await importFamilyCredentials();
 client=new GatewayClient({store:{loadIdentity:()=>load('identity'),saveIdentity:v=>save('identity',v),loadConnection:()=>load('connection'),saveConnection:v=>save('connection',v)},client:{id:'webchat',version:'0.1.0',platform:'windows',mode:'ui',deviceFamily:'desktop'},WebSocketImpl:WebSocket});
 client.on('status',()=>emit('status',status()));client.on('event',(type,payload)=>emit(type,payload));
 win=new BrowserWindow({width:1250,height:850,minWidth:760,minHeight:550,backgroundColor:'#212121',title:'HomeAI',webPreferences:{preload:path.join(here,'../preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.setWindowOpenHandler(({url})=>{if(url.startsWith('https://'))shell.openExternal(url);return {action:'deny'};});
 win.webContents.on('will-navigate',e=>e.preventDefault());
 win.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'HomeAI',submenu:[{role:'quit'}]},{label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
 const handlers={
  status:()=>status(),
  configure:async p=>{const code=text(p.setupCode,16384);parseSetupCode(code);await client.configure({setupCode:code});return status();},
  forget:()=>client.forget(),reconnect:()=>client.start(),
  sessions:()=>client.listSessions(),history:p=>client.history(text(p.key,512)),
  newSession:p=>newSessionKey(text(p.agent||'main',80)),
  send:p=>client.sendMessage({sessionKey:text(p.key,512),message:text(p.message),attachments:attachments(p.attachments),thinking:p.thinking||undefined}),
  captureScreen:async()=>{const primary=screen.getPrimaryDisplay();const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1920,height:1080}});const source=sources.find(s=>s.display_id===String(primary.id))??sources[0];if(!source||source.thumbnail.isEmpty())throw new Error('Screen capture is unavailable.');const image=source.thumbnail.toJPEG(85);return {type:'image',mimeType:'image/jpeg',fileName:'Screenshot.jpg',content:image.toString('base64'),sizeBytes:image.length};},
  abort:p=>client.abort(text(p.key,512)),models:()=>client.listModels(),agents:()=>client.listAgents(),
  model:p=>client.patchSession(text(p.key,512),{model:text(p.model,256)}),
  export:async p=>{const content=text(p.content,2000000);const result=await dialog.showSaveDialog(win,{defaultPath:'HomeAI conversation.md',filters:[{name:'Markdown',extensions:['md']}]});if(!result.canceled)await writeFile(result.filePath,content,'utf8');return !result.canceled;}
 };
 ipcMain.handle('homeai:invoke',async(event,method,p={})=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('Untrusted caller');if(!Object.hasOwn(handlers,method))throw new Error('Unknown operation');try{return {ok:true,value:await handlers[method](p)};}catch(e){return {ok:false,error:e.message};}});
 await win.loadFile(path.join(here,'../renderer/index.html'));
 await client.start();
}).catch(e=>dialog.showErrorBox('HomeAI',e.message));
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>client?.stop());
