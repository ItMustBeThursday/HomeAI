// Text state only. Capture, transport and playback are adapter responsibilities.
const validId = id => typeof id==='string' && id.trim().length>0 && id.length<=256;
export function createVoiceSession({maxTextLength=4000,maxRequests=4096}={}) {
  if (!Number.isSafeInteger(maxTextLength) || maxTextLength<=0) throw new TypeError('Invalid maxTextLength');
  if (!Number.isSafeInteger(maxRequests) || maxRequests<1 || maxRequests>65536) throw new TypeError('Invalid maxRequests');
  let state='idle', requestId=null;
  const issuedIds=new Set(); // IDs only; never audio or transcript retention.
  const reject=reason=>[{type:'reject',reason}];
  function handle(e) {
    if (!e || typeof e!=='object' || Array.isArray(e) ||
        !['start','stopCapture','transcript','response','playbackDone','cancel','disconnect','error'].includes(e.type) ||
        !validId(e.requestId)) return reject('malformed');
    if (e.type==='start') {
      if (issuedIds.has(e.requestId)) return reject('reused-request-id');
      // Fail closed rather than evicting IDs and permitting stale response replay.
      // An adapter rotates this controller only after detaching old transports.
      if (issuedIds.size>=maxRequests) return reject('session-capacity');
      const effects=requestId===null ? [] : [{type:'stop',requestId}];
      requestId=e.requestId; issuedIds.add(requestId); state='listening';
      return [...effects,{type:'capture',requestId}];
    }
    if (requestId===null || e.requestId!==requestId) return reject('stale-request');
    if (['cancel','disconnect','error'].includes(e.type)) {
      const stoppedId=requestId;
      requestId=null; state=e.type==='cancel' ? 'idle' : 'error';
      return [{type:'stop',requestId:stoppedId}];
    }
    if (e.type==='stopCapture') {
      if (state!=='listening') return reject('invalid-state');
      state='transcribing'; return [{type:'transcribe',requestId}];
    }
    if (e.type==='transcript' || e.type==='response') {
      if (state!==(e.type==='transcript' ? 'transcribing' : 'thinking')) return reject('invalid-state');
      if (typeof e.text!=='string' || !e.text.trim() || e.text.length>maxTextLength) return reject('invalid-text');
      state=e.type==='transcript' ? 'thinking' : 'speaking';
      return [{type:e.type==='transcript' ? 'request' : 'speak',requestId,text:e.text}];
    }
    if (state!=='speaking') return reject('invalid-state');
    state='idle'; requestId=null; return [];
  }
  return {handle,snapshot:()=>({state,requestId,textFallbackAvailable:true})};
}
