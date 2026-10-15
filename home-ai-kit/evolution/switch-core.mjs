// Pure deterministic switch state; adapters own device I/O and trusted local events.
const int = Number.isSafeInteger;
const name = s => typeof s === 'string' && s.trim().length > 0 && s.length <= 256;
const names = (a,min,max=Infinity) => Array.isArray(a) && a.length>=min && a.length<=max && a.every(name) && new Set(a).size===a.length;
// Bounded per-device memory of superseded sessions; reusing one is a replay.
const MAX_RETIRED_SESSIONS = 8;
export function createSwitchController(config) {
  if (!config || !names(config.deviceIds,0,4) || !names(config.itemIds,1) ||
      !['one','two'].includes(config.mode) || !int(config.debounceMs) || config.debounceMs<0 ||
      !int(config.scanIntervalMs) || config.scanIntervalMs<=0 || !int(config.maxAgeMs) || config.maxAgeMs<=0)
    throw new TypeError('Invalid switch configuration');
  const {mode,debounceMs,scanIntervalMs,maxAgeMs} = config;
  const items = [...config.itemIds];
  const buttons = () => [{held:false,lastPressAt:null},{held:false,lastPressAt:null}];
  const devices = new Map(config.deviceIds.map(id=>[id,{connected:true,sessionId:null,retiredSessionIds:[],seq:-1,lastAt:null,buttons:buttons()}]));
  let index=0, paused=false, lastAt=null, lastTickAt=null;
  const reject = reason => [{type:'reject',reason}];
  const highlight = () => [{type:'highlight',index,itemId:items[index]},{type:'feedback',action:'highlight',itemId:items[index]}];
  function handle(e) {
    if (!e || typeof e!=='object' || Array.isArray(e) ||
        !['press','release','tick','disconnect','connect','override'].includes(e.kind) ||
        !int(e.at) || e.at<0 || !int(e.receivedAt) || e.receivedAt<0) return reject('malformed');
    if (e.at>e.receivedAt) return reject('future');
    if (e.receivedAt-e.at>maxAgeMs) return reject('old');
    if (lastAt!==null && e.at<lastAt) return reject('non-monotonic');
    if (e.kind==='override') {
      if (typeof e.paused!=='boolean') return reject('malformed');
      lastAt=e.at; paused=e.paused;
      return [{type:'paused',paused,reason:'caregiver'}];
    }
    if (e.kind==='tick') {
      lastAt=e.at;
      if (paused) return reject('paused');
      if (mode!=='one') return [];
      if (lastTickAt!==null && e.at-lastTickAt<scanIntervalMs) return [];
      lastTickAt=e.at; index=(index+1)%items.length; return highlight();
    }
    const d=devices.get(e.deviceId);
    if (!d || !name(e.sessionId) || !int(e.seq) || e.seq<0 ||
        (['press','release'].includes(e.kind) && ![1,2].includes(e.button))) return reject('malformed');
    const same=e.sessionId===d.sessionId;
    if (d.lastAt!==null && e.at<d.lastAt) return reject('non-monotonic');
    if (d.retiredSessionIds.includes(e.sessionId)) return reject('retired-session');
    if (d.sessionId!==null && !same && e.kind!=='connect') return reject('session');
    if (same && e.seq<=d.seq) return reject('sequence');
    if (!d.connected && e.kind!=='connect') return reject('disconnected');
    if (e.kind==='connect' && d.sessionId!==null && same) return reject('new-session-required');
    if (e.kind==='connect' && d.sessionId!==null) {
      d.retiredSessionIds.push(d.sessionId);
      if (d.retiredSessionIds.length>MAX_RETIRED_SESSIONS) d.retiredSessionIds.shift();
    }
    d.sessionId=e.sessionId; d.seq=e.seq; d.lastAt=e.at; lastAt=e.at;
    if (e.kind==='disconnect') {
      d.connected=false; d.buttons=buttons(); paused=true;
      return [{type:'paused',paused:true,reason:'disconnect',deviceId:e.deviceId}];
    }
    if (e.kind==='connect') {
      d.connected=true; d.buttons=buttons();
      return [{type:'feedback',action:'connected',deviceId:e.deviceId}];
    }
    const b=d.buttons[e.button-1];
    if (e.kind==='release') { b.held=false; return []; }
    if (b.held) return reject('held');
    b.held=true;
    if (b.lastPressAt!==null && e.at-b.lastPressAt<debounceMs) return reject('debounce');
    b.lastPressAt=e.at;
    if (paused) return reject('paused');
    if (mode==='one' && e.button!==1) return reject('unsupported-button');
    if (mode==='two' && e.button===1) { index=(index+1)%items.length; return highlight(); }
    return [{type:'select',index,itemId:items[index],deviceId:e.deviceId},{type:'feedback',action:'select',itemId:items[index]}];
  }
  return {handle,snapshot:()=>({mode,index,itemId:items[index],paused,lastAt,lastTickAt,
    devices:Object.fromEntries([...devices].map(([id,d])=>[id,{...d,retiredSessionIds:[...d.retiredSessionIds],buttons:d.buttons.map(b=>({...b}))}]))})};
}
