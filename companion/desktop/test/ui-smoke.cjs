// Real sandboxed Electron renderer, deterministic offline IPC fixtures.
// This checks delivered controls and screenshots, not a live Gateway or installer.
const {app,BrowserWindow,ipcMain,nativeTheme}=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
let win,sequence=0;
const calls=[],rendererErrors=[];
const output=path.resolve('../verification');
const primary='agent:main:companion:test';
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/U0AAAAASUVORK5CYII=';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const js=code=>win.webContents.executeJavaScript(code,true);
async function check(name,code,expected=true){const actual=await js(code);assert.deepEqual(actual,expected,name);console.log('PASS',name);}
async function screenshot(name){await wait(100);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());}
async function until(code){for(let tries=0;tries<60;tries++){if(await js(code))return;await wait(40);}throw new Error('Timed out: '+code);}
const sendEvent=(type,payload)=>win.webContents.send('homeai:event',{type,payload});
app.whenReady().then(async()=>{
 nativeTheme.themeSource='dark';fs.mkdirSync(output,{recursive:true});
 const now=Date.now();
 const fixtureSessions=[
  {key:primary,label:'A calmer, more productive week',updatedAt:now},
  {key:'chat-2',label:'Ideas for a weekend away',updatedAt:now},
  {key:'chat-3',label:'A little help with dinner',updatedAt:now},
  {key:'chat-4',label:'Understanding the bigger picture',updatedAt:now-86400000},
  {key:'chat-5',label:'Notes from the garden',updatedAt:now-86400000},
  {key:'chat-6',label:'Building something new',updatedAt:now-4*86400000},
  {key:'chat-7',label:'The reading list',updatedAt:now-8*86400000}
 ];
 ipcMain.handle('homeai:invoke',async(_event,method,params)=>{
  calls.push({method,params});let value=null;
  if(method==='status')value={state:'connected',defaultUrl:'wss://example.com/companion',capabilities:{captureScreen:true,attachments:true},detail:{policy:{attachments:{maxBytes:5*1024*1024,maxImageBytes:5*1024*1024}}}};
  else if(method==='sessions')value={sessions:fixtureSessions};
  else if(method==='history')value={messages:[{role:'user',content:'Help me plan a calmer, more productive week.'},{role:'assistant',content:'Absolutely. A good week starts with a little breathing room. Here’s a simple approach:\n\n### Start with what matters\n\n1. **Choose three priorities.** Focus on the things that will make the biggest difference.\n2. **Make room to focus.** Set aside one quiet block each morning.\n3. **Leave some space.** A realistic plan has room for the unexpected.\n\n**Safe markdown**\n\n<script>window.PWNED=true</script>\n\n```js\nconst priorities = ["Focus", "Make progress", "Take a break"];\nconsole.log("Hello HomeAI");\n```\n\nWhat would you most like to make time for this week?'}]};
  else if(method==='models')value={models:[{id:'test',provider:'homeai',name:'Balanced'},{id:'fast',provider:'homeai',name:'Fast'}]};
  else if(method==='agents')value={agents:[{id:'main',name:'Main assistant'},{id:'creative',name:'Creative assistant'}]};
  else if(method==='newSession')value='agent:'+params.agent+':companion:new-'+(++sequence);
  else if(method==='captureScreen')value={type:'image',mimeType:'image/png',fileName:'Screenshot.png',sizeBytes:68,content:pixel};
  else if(method==='export')value=true;
  return{ok:true,value};
 });
 win=new BrowserWindow({show:false,width:1250,height:850,webPreferences:{preload:path.resolve('src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'ui-smoke-'+process.pid}});
 win.webContents.on('console-message',(_event,...args)=>{if(args[0]===3)rendererErrors.push(String(args[1]));});
 await win.loadFile(path.resolve('src/renderer/index.html'));
 await until("document.querySelectorAll('.session').length === 7");
 await check('dark ChatGPT surface tokens',"[getComputedStyle(document.body).backgroundColor,getComputedStyle(document.getElementById('sidebar')).backgroundColor,getComputedStyle(document.getElementById('composer')).backgroundColor]",['rgb(33, 33, 33)','rgb(23, 23, 23)','rgb(48, 48, 48)']);
 await check('empty state, grouping and no send without a message',"document.querySelector('.welcome h1').textContent==='What can I help with?' && document.querySelectorAll('.session-group-label').length===4 && document.getElementById('send').disabled");
 await check('sandbox and preload bridge',"[typeof require,typeof homeai.call,!!window.PWNED]",['undefined','function',false]);
 await screenshot('desktop-empty-dark.png');
 await js("document.getElementById('search-open').click();document.getElementById('search').value='week';document.getElementById('search').dispatchEvent(new Event('input'))");
 await check('search opens and filters actual chats',"document.getElementById('search-dialog').open && document.querySelectorAll('.search-result').length===2");
 await screenshot('desktop-search-dark.png');
 await js("document.getElementById('search-close').click();document.querySelector('.session').click()");
 await until("document.querySelectorAll('.message').length===2");
 await js("window.voiceUtterances=[];window.voiceCancels=0;Object.defineProperty(speechSynthesis,'speak',{configurable:true,value:u=>voiceUtterances.push(u)});Object.defineProperty(speechSynthesis,'cancel',{configurable:true,value:()=>voiceCancels++})");
 await check('read-aloud is opt-in with a hidden stop control',"!!document.querySelector('.read-aloud') && document.getElementById('stop-speech').hidden && voiceUtterances.length===0");
 await js("document.querySelector('.read-aloud').click()");
 await check('read-aloud starts one platform utterance and exposes stop',"voiceUtterances.length===1 && !document.getElementById('stop-speech').hidden && voiceUtterances[0].text.includes('Absolutely.')");
 await js("document.getElementById('stop-speech').click();voiceUtterances[0].onend() ");
 await check('stop control cancels and stale end cannot restart speech',"document.getElementById('stop-speech').hidden && voiceUtterances.length===1 && voiceCancels>=2");
 await js("document.querySelector('.read-aloud').click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
 await check('Escape cancels response speech',"document.getElementById('stop-speech').hidden");
 await check('user bubble, Markdown heading, code copy and script inertness',"document.querySelectorAll('.message.user').length===1 && !!document.querySelector('.message h3') && document.querySelectorAll('pre code').length===1 && !!document.querySelector('.copy-code') && !window.PWNED && document.querySelectorAll('#transcript script').length===0");
 await js("document.getElementById('transcript').scrollTop=0");
 await screenshot('desktop-chat-dark.png');
 await js("document.getElementById('settings').click()");
 await check('settings dialog opens',"document.getElementById('dialog').open && !document.getElementById('settings-general').hidden");
 await screenshot('desktop-settings-dark.png');
 await js("document.getElementById('appearance').value='light';document.getElementById('appearance').dispatchEvent(new Event('change'));document.getElementById('close').click();document.getElementById('new').click()");
 await until("document.querySelector('.welcome')!==null");
 await check('light appearance is applied and persisted',"document.documentElement.dataset.theme==='light' && localStorage.getItem('homeai.appearance')==='light' && getComputedStyle(document.body).backgroundColor==='rgb(255, 255, 255)'");
 await screenshot('desktop-empty-light.png');
 await js("document.getElementById('settings').click();document.getElementById('appearance').value='dark';document.getElementById('appearance').dispatchEvent(new Event('change'));document.getElementById('close').click();document.getElementById('sidebar-close').click()");
 await check('sidebar collapses and reopens',"document.body.classList.contains('sidebar-collapsed') && !document.getElementById('sidebar-open').hidden");
 await screenshot('desktop-compact-dark.png');
 await js("document.getElementById('sidebar-open').click();document.getElementById('model-trigger').click();document.getElementById('model').value='homeai/test';document.getElementById('model').dispatchEvent(new Event('change'));document.getElementById('thinking').value='medium';document.getElementById('thinking').dispatchEvent(new Event('change'))");
 await check('model and reasoning controls reflect selection',"!document.getElementById('model-popover').hidden && document.getElementById('model-name').textContent==='Balanced' && document.getElementById('composer-context').textContent==='Reasoning: Standard'");
 await js("document.getElementById('model-trigger').click();document.getElementById('message').value='Keep Friday afternoon free.';document.getElementById('message').dispatchEvent(new Event('input'))");
 await check('typing enables send',"!document.getElementById('send').disabled");
 await js("document.getElementById('composer').requestSubmit()");
 await until("!document.getElementById('stop').hidden");
 const sent=calls.find(item=>item.method==='send');assert.equal(sent.params.message,'Keep Friday afternoon free.');assert.equal(sent.params.thinking,'medium');assert.ok(calls.some(item=>item.method==='model'&&item.params.model==='homeai/test'));console.log('PASS send uses selected model and reasoning through IPC');
 sendEvent('chat',{sessionKey:sent.params.key,state:'delta',deltaText:'That sounds like a great idea.'});
 await until("document.querySelector('.message.assistant')?.textContent.includes('great idea')");
 await js("document.getElementById('stop').click()");assert.ok(calls.some(item=>item.method==='abort'&&item.params.key===sent.params.key));console.log('PASS stop reaches abort IPC');
 sendEvent('chat',{sessionKey:sent.params.key,state:'final',message:{content:'That sounds like a great idea. Let’s keep Friday afternoon open.'}});
 await until("document.getElementById('stop').hidden");
 await check('stream final replaces in-flight text exactly once',"document.querySelectorAll('.message.assistant').length===1 && !!document.querySelector('.message-actions')");
 await js("document.getElementById('new').click()");await until("document.querySelector('.welcome')!==null");
 await js("document.getElementById('screenshot').click()");await until("document.querySelectorAll('.attachment').length===1");
 await check('screenshot adds real bridge attachment and enables file-only send',"document.querySelector('.attachment-name').textContent==='Screenshot.png' && !document.getElementById('send').disabled && !!document.querySelector('.attachment img')");
 await js("document.querySelector('.attachment button').click()");
 await check('attachment removal disables empty send',"document.querySelectorAll('.attachment').length===0 && document.getElementById('send').disabled");
 await js("(()=>{const data=new DataTransfer();data.items.add(new File(['attachment fixture'],'notes.txt',{type:'text/plain'}));document.getElementById('message').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true}));})()");
 await until("document.querySelectorAll('.attachment').length===1");
 await js("document.getElementById('composer').requestSubmit()");await until("!document.getElementById('stop').hidden");
 const fileSend=calls.filter(item=>item.method==='send').at(-1);assert.equal(fileSend.params.attachments[0].fileName,'notes.txt');assert.equal(Buffer.from(fileSend.params.attachments[0].content,'base64').toString(),'attachment fixture');console.log('PASS paste attachment forwarded through IPC with exact contents');
 sendEvent('chat',{sessionKey:fileSend.params.key,state:'final',message:{content:'I received your notes.'}});await until("document.getElementById('stop').hidden");
 await js("(()=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(5*1024*1024+1)],'too-large.txt',{type:'text/plain'}));document.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true}));})()");
 await check('oversized drop is rejected before IPC',"document.getElementById('notice').textContent.includes('too large') && document.querySelectorAll('.attachment').length===0");
 await js("document.getElementById('export').click()");await wait(40);assert.ok(calls.some(item=>item.method==='export'&&item.params.content.includes('I received your notes.')));console.log('PASS transcript export');
 win.setSize(760,600);await wait(120);
 await check('minimum window has no horizontal document overflow',"document.documentElement.scrollWidth<=innerWidth && document.getElementById('composer').getBoundingClientRect().right<=innerWidth");
 assert.deepEqual(rendererErrors,[],'No renderer console errors');
 console.log('ELECTRON_UI_SMOKE_PASS',JSON.stringify({screenshots:6,fixtureOnly:true,rendererErrors:rendererErrors.length}));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
