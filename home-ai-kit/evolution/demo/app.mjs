import {createSwitchController} from './switch-core.mjs';
const byId=id=>document.getElementById(id),items=['Music','Story','Quiet','Repeat','Cancel','Help'],deviceId='lab-primary';
let controller=null,timer=null,seq=0,sessionId='',paused=true,connected=false;
let speechBusy=false,speechEpoch=0,acceptAfter=0,interval=2000,lastChoice='Music';
const pressedKeys=new Map();
function stopSpeech(){speechEpoch++;speechBusy=false;window.speechSynthesis?.cancel();}
function scheduleScan(){
  clearTimeout(timer);
  if(!controller||paused||speechBusy||controller.snapshot().mode!=='one')return;
  timer=setTimeout(()=>{if(!paused&&!speechBusy)processEvent({kind:'tick'});},Math.max(0,acceptAfter-performance.now())+interval);
}
function speak(text){
  clearTimeout(timer);stopSpeech();
  acceptAfter=performance.now()+Number(byId('grace').value);
  if(!byId('audio').checked){scheduleScan();return;}
  const voice=window.speechSynthesis?.getVoices().find(v=>v.localService&&v.lang.startsWith('en'));
  if(!voice){pause();byId('status').textContent='Paused: no local voice available. Caregiver may disable audio for visual-only testing.';return;}
  speechBusy=true;const epoch=speechEpoch;
  const utterance=new SpeechSynthesisUtterance(text);utterance.voice=voice;
  utterance.onend=()=>{if(epoch!==speechEpoch)return;speechBusy=false;acceptAfter=performance.now()+Number(byId('grace').value);scheduleScan();};
  utterance.onerror=()=>{if(epoch!==speechEpoch)return;pause();byId('status').textContent='Paused: speech failed. Caregiver action required.';};
  speechSynthesis.speak(utterance);
}
function render(){
  if(!controller)return;
  const state=controller.snapshot();paused=state.paused;
  for(const [index,element] of [...byId('choices').children].entries()){
    element.classList.toggle('active',index===state.index);
    element.textContent=items[index]+(index===state.index?' — current choice':'');
  }
  for(const id of ['pause','resume','disconnect','reconnect','button1','button2'])byId(id).disabled=false;
  byId('button1').disabled=!connected;
  byId('button2').disabled=!connected||state.mode==='one';
  byId('disconnect').disabled=!connected;
  byId('reconnect').disabled=connected;
  byId('resume').disabled=!connected||!paused;
  byId('pause').disabled=paused;
}
function processEvent(event){
  if(!controller)return;
  const now=Math.floor(performance.now());
  const effects=controller.handle({...event,at:now,receivedAt:now});
  for(const effect of effects){
    if(effect.type==='select'||effect.type==='highlight'){
      const text=(effect.type==='select'?'Selected ':'Choice: ')+(effect.itemId??items[effect.index]);
      byId('status').textContent=text;speak(text);
      if(effect.type==='select'){
        if(effect.itemId==='Cancel'||effect.itemId==='Help'){pause();byId('status').textContent=effect.itemId==='Help'?'Help requested. Paused for caregiver.':'Cancelled. Paused.';speak(byId('status').textContent);}
        else if(effect.itemId==='Repeat')speak('Choice: '+lastChoice);
        else lastChoice=effect.itemId;
      }
    }
    if(effect.type==='paused'){
      paused=effect.paused;
      byId('status').textContent=paused?'Paused. Caregiver resume required.':'Ready.';
      if(paused){clearTimeout(timer);stopSpeech();}
    }
    if(effect.type==='reject'&&event.kind==='press')byId('status').textContent='Input ignored: '+effect.reason+'.';
  }
  render();
}
function edge(kind,button){
  if(!connected)return;
  if(kind==='press'&&(speechBusy||performance.now()<acceptAfter)){
    byId('status').textContent='Input ignored: wait for the choice announcement and acceptance delay.';return;
  }
  processEvent({kind,button,deviceId,sessionId,seq:seq++});
}
function releaseKeys(){for(const button of pressedKeys.values())edge('release',button);pressedKeys.clear();}
function pause(){releaseKeys();edge('release',1);edge('release',2);processEvent({kind:'override',paused:true});stopSpeech();clearTimeout(timer);}
byId('start').addEventListener('click',()=>{
  interval=Number(byId('interval').value);
  if(!Number.isInteger(interval)||interval<500||interval>10000){byId('status').textContent='Choose a scan interval from 500 through 10000 milliseconds.';return;}
  const grace=Number(byId('grace').value);
  if(!Number.isInteger(grace)||grace<0||grace>3000){byId('status').textContent='Choose an acceptance delay from 0 through 3000 milliseconds.';return;}
  clearTimeout(timer);stopSpeech();pressedKeys.clear();seq=0;sessionId=crypto.randomUUID();
  controller=createSwitchController({deviceIds:[deviceId],mode:byId('mode').value,itemIds:items,debounceMs:120,scanIntervalMs:interval,maxAgeMs:3000});
  connected=true;paused=false;
  byId('choices').replaceChildren(...items.map(text=>{const element=document.createElement('div');element.className='choice';element.textContent=text;return element;}));
  processEvent({kind:'connect',deviceId,sessionId,seq:seq++});render();
  byId('status').textContent='Ready: Music.';speak('Music');
  byId('keyboard').focus();
});
byId('pause').onclick=pause;
byId('resume').onclick=()=>{if(connected){processEvent({kind:'override',paused:false});speak('Choice: '+controller.snapshot().itemId);}};
byId('disconnect').onclick=()=>{releaseKeys();processEvent({kind:'disconnect',deviceId,sessionId,seq:seq++});connected=false;render();};
byId('reconnect').onclick=()=>{
  if(!controller||connected)return;
  sessionId=crypto.randomUUID();seq=0;connected=true;
  processEvent({kind:'connect',deviceId,sessionId,seq:seq++});
  byId('status').textContent='Reconnected. Paused until caregiver resumes.';render();
};
byId('audio').onchange=()=>{if(controller)pause();};
for(const button of [1,2]){
  const element=byId('button'+button);
  element.addEventListener('pointerdown',event=>{if(event.button!==0)return;element.setPointerCapture(event.pointerId);edge('press',button);});
  for(const kind of ['pointerup','pointercancel','lostpointercapture'])element.addEventListener(kind,()=>edge('release',button));
  element.addEventListener('click',event=>{if(event.detail===0){edge('press',button);edge('release',button);}});
}
document.addEventListener('keydown',event=>{
  const switchButton=event.target===byId('button1')?1:event.target===byId('button2')?2:null;
  if(event.target!==byId('keyboard')&&!switchButton)return;
  if(!['Space','Enter'].includes(event.code))return;
  event.preventDefault();if(event.repeat||pressedKeys.has(event.code))return;
  const button=switchButton??(event.code==='Space'?1:2);
  pressedKeys.set(event.code,button);edge('press',button);
});
document.addEventListener('keyup',event=>{
  const button=pressedKeys.get(event.code);if(!button)return;
  event.preventDefault();pressedKeys.delete(event.code);edge('release',button);
});
window.addEventListener('blur',()=>{if(controller)pause();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&controller)pause();});
window.addEventListener('pagehide',()=>{clearTimeout(timer);stopSpeech();});
