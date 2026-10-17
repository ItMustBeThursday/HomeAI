// Voice: talk to HoopyFrood (microphone -> local Whisper), hear replies (local Kokoro or a cloned voice via Chatterbox),
// and manage cloned voices. Everything is processed by the voice service on this PC.
export function setupVoice({ h, getToken, bootstrapToken, toast, sendText, isBusy }) {
  const $ = (s) => document.querySelector(s);
  const store = {
    get: (k, d) => { try { return JSON.parse(localStorage.getItem(`homeai-voice-${k}`)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`homeai-voice-${k}`, JSON.stringify(v)); } catch {} },
  };
  let speakOn = store.get('speak', false);
  let voiceName = store.get('voice', 'af_heart');
  let speed = store.get('speed', 1);
  let handsFree = false;
  let rec = null;          // active recorder { stop, cancel }
  let player = null;       // current Audio
  let finishPlayback = null;
  let speakToken = 0;      // bumps to cancel queued speech
  let available = false;

  const auth = async () => { await bootstrapToken(); const t = getToken(); return t ? { authorization: `Bearer ${t}` } : {}; };
  async function vfetch(path, init = {}) {
    const res = await fetch(path, { ...init, headers: { ...(await auth()), ...(init.headers || {}) } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res;
  }

  // ---- recording with silence detection ----
  async function record({ maxMs = 60_000, silenceMs = 1400, stopOnSilence = true } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mr = new MediaRecorder(stream);
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let heard = false, lastLoud = performance.now(), cancelled = false;
    const t0 = performance.now();
    let done;
    const finished = new Promise((r) => { done = r; });
    const level = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
    const timer = setInterval(() => {
      const l = level(), now = performance.now();
      micBtn.style.setProperty('--lvl', Math.min(1, l * 12).toFixed(2));
      if (l > 0.02) { heard = true; lastLoud = now; }
      if (now - t0 > maxMs || (stopOnSilence && heard && now - lastLoud > silenceMs) || (stopOnSilence && !heard && now - t0 > 12_000)) stop();
    }, 80);
    function stop() { if (mr.state !== 'inactive') mr.stop(); }
    mr.onstop = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      done(cancelled || !heard ? null : new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
    };
    mr.start();
    rec = { stop, cancel: () => { cancelled = true; stop(); } };
    const blob = await finished;
    rec = null;
    return blob;
  }

  async function transcribe(blob) {
    const res = await vfetch('/api/voice/stt', { method: 'POST', body: blob, headers: { 'content-type': 'application/octet-stream' } });
    return (await res.json()).text || '';
  }

  // ---- speaking ----
  function speakable(text) {
    return String(text || '').replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/`([^`]+)`/g, '$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'link').replace(/[*_#>|~]/g, '').replace(/\s+/g, ' ').trim();
  }
  function sentences(text) {
    const out = []; let cur = '';
    for (const part of text.match(/[^.!?]+[.!?]*\s*/g) || [text]) {
      if ((cur + part).length > 220 && cur) { out.push(cur.trim()); cur = part; } else cur += part;
    }
    if (cur.trim()) out.push(cur.trim());
    return out.slice(0, 12);
  }
  const fetchClip = async (text) => URL.createObjectURL(await (await vfetch('/api/voice/tts', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice: voiceName, speed }),
  })).blob());
  function playUrl(url, my) {
    return new Promise((resolve) => {
      if (my !== speakToken) { URL.revokeObjectURL(url); return resolve(); }
      const a = new Audio(url); player = a;
      const finish = () => { URL.revokeObjectURL(url); if (player === a) player = null; if (finishPlayback === finish) finishPlayback = null; resolve(); };
      finishPlayback = finish;
      a.onended = a.onerror = finish;
      a.play().catch(() => { finish(); toast('Audio playback needs a browser interaction. Click Test voice.', 'bad'); });
    });
  }
  async function speak(text) {
    stopSpeaking();
    const parts = sentences(speakable(text));
    if (!parts.length) return;
    const my = ++speakToken;
    setStatus('Speaking…');
    try {
      for (let i = 0; i < parts.length && my === speakToken; i++) {
        const url = await fetchClip(parts[i]);
        await playUrl(url, my);
      }
    } catch (err) { toast(`Voice: ${err.message}`, 'bad'); }
    if (my === speakToken) setStatus('');
  }
  function stopSpeaking() { speakToken++; player?.pause(); finishPlayback?.(); setStatus(''); }

  // ---- UI ----
  const micBtn = h('button', { type: 'button', class: 'ghost sm mic', id: 'mic', title: 'Dictate (click, speak, pause)' }, 'Mic');
  const talkBtn = h('button', { type: 'button', class: 'ghost sm', id: 'talk', title: 'Hands-free conversation: listens, replies out loud, listens again' }, 'Talk');
  const settingsBtn = h('button', { type: 'button', class: 'ghost sm', id: 'voice-settings', title: 'Voice settings and cloning' }, 'Voice');
  const audioFile = h('input', { type: 'file', accept: 'audio/*', hidden: true, id: 'transcribe-file' });
  const uploadBtn = h('button', { type: 'button', class: 'ghost sm', id: 'audio-upload', title: 'Transcribe an audio file into the message box' }, 'Audio file');
  const stopBtn = h('button', { type: 'button', class: 'ghost sm', id: 'voice-stop', title: 'Stop speaking and listening' }, 'Quiet');
  const status = h('span', { class: 'muted', id: 'voice-status', role: 'status' }, '');
  const setStatus = (t) => { status.textContent = t; };
  $('#attach').after(micBtn, talkBtn, uploadBtn, settingsBtn, stopBtn, audioFile, status);
  stopBtn.onclick = () => { handsFree = false; rec?.cancel(); stopSpeaking(); };
  uploadBtn.onclick = () => audioFile.click();
  audioFile.onchange = async () => {
    const file = audioFile.files[0];
    if (!file) return;
    try {
      if (file.size > 25_000_000) throw new Error('Audio upload exceeds 25 MB');
      setStatus('Transcribing audio file…');
      const text = await transcribe(file);
      const p = $('#prompt'); p.value = (p.value ? `${p.value} ` : '') + text;
      p.dispatchEvent(new Event('input')); p.focus();
    } catch (err) { toast(`Voice: ${err.message}`, 'bad'); }
    finally { setStatus(''); audioFile.value = ''; }
  };

  async function dictate() {
    if (rec) return rec.stop();
    stopSpeaking();
    micBtn.classList.add('on'); setStatus('Listening…');
    try {
      const blob = await record();
      micBtn.classList.remove('on');
      if (!blob) { setStatus(''); return null; }
      setStatus('Transcribing…');
      const text = (await transcribe(blob)).trim();
      setStatus('');
      return text;
    } catch (err) {
      micBtn.classList.remove('on'); setStatus('');
      toast(err.name === 'NotAllowedError' ? 'Microphone permission was denied' : `Voice: ${err.message}`, 'bad');
      return null;
    }
  }
  micBtn.onclick = async () => {
    const text = await dictate();
    if (text) { const p = $('#prompt'); p.value = (p.value ? `${p.value} ` : '') + text; p.dispatchEvent(new Event('input')); p.focus(); }
  };

  async function loop() {
    while (handsFree) {
      // wait for the previous reply to finish being generated and spoken before listening again
      await new Promise((r) => setTimeout(r, 400));
      while (handsFree && (isBusy() || player || status.textContent === 'Speaking…')) await new Promise((r) => setTimeout(r, 300));
      if (!handsFree) break;
      talkBtn.classList.add('on'); micBtn.classList.add('on'); setStatus('Listening…');
      let text = null;
      try {
        const blob = await record({ maxMs: 90_000 });
        micBtn.classList.remove('on');
        if (blob) { setStatus('Transcribing…'); text = (await transcribe(blob)).trim(); }
      } catch (err) { toast(`Voice: ${err.message}`, 'bad'); handsFree = false; break; }
      micBtn.classList.remove('on'); setStatus('');
      if (text && handsFree) {
        if (/^(stop|stop listening|goodbye|that's all)[.!]?$/i.test(text)) { handsFree = false; break; }
        speakOn = true; sync();
        await sendText(text);
      }
    }
    talkBtn.classList.remove('on'); micBtn.classList.remove('on'); setStatus('');
  }
  talkBtn.onclick = () => {
    if (handsFree) { handsFree = false; rec?.cancel(); stopSpeaking(); talkBtn.classList.remove('on'); return; }
    handsFree = true; loop();
  };

  // ---- settings dialog ----
  const dlg = h('dialog', { class: 'panel voice-dialog', id: 'voice-dialog' });
  const speakChk = h('input', { type: 'checkbox', id: 'voice-speak' });
  const voiceSel = h('select', { id: 'voice-select' });
  const speedIn = h('input', { type: 'range', min: '0.7', max: '1.3', step: '0.05', id: 'voice-speed' });
  const cloneName = h('input', { type: 'text', id: 'clone-name', placeholder: 'name, e.g. adam', maxlength: 40 });
  const cloneRec = h('button', { type: 'button', class: 'ghost sm' }, 'Record sample');
  const cloneFile = h('input', { type: 'file', accept: 'audio/*', id: 'clone-file' });
  const cloneMsg = h('div', { class: 'muted', role: 'status' }, '');
  const cloneList = h('div', { id: 'clone-list' });
  const testBtn = h('button', { type: 'button', class: 'ghost sm' }, 'Test voice');
  const closeBtn = h('button', { type: 'button', class: 'primary sm' }, 'Close');
  dlg.append(
    h('h3', {}, 'Voice'),
    h('div', { class: 'muted' }, 'Audio is processed on this PC. Transcribed words use your selected chat model; select a local model to keep the conversation local. Microphone access requires localhost or HTTPS.'),
    h('label', { class: 'row mt' }, speakChk, ' Read replies aloud'),
    h('label', { class: 'sel mt' }, 'Voice ', voiceSel),
    h('label', { class: 'sel mt' }, 'Speed ', speedIn),
    h('div', { class: 'row mt' }, testBtn),
    h('h4', { class: 'mt' }, 'Clone a voice'),
    h('div', { class: 'muted' }, 'Record or upload 10-30 seconds of one person speaking clearly, no music. Only clone voices you have permission to use.'),
    h('div', { class: 'row mt' }, cloneName, cloneRec, cloneFile),
    cloneMsg, cloneList,
    h('div', { class: 'row mt' }, h('span', { class: 'spacer' }), closeBtn));
  document.body.append(dlg);

  function sync() { speakChk.checked = speakOn; speedIn.value = speed; store.set('speak', speakOn); store.set('voice', voiceName); store.set('speed', speed); }
  async function loadVoices() {
    try {
      const v = await (await vfetch('/api/voice/voices')).json();
      voiceSel.replaceChildren(
        h('optgroup', { label: 'Cloned' }, ...v.clones.map((c) => h('option', { value: `clone:${c}` }, c))),
        h('optgroup', { label: 'Built-in' }, ...v.builtin.map((b) => h('option', { value: b }, b))));
      if (![...voiceSel.options].some((o) => o.value === voiceName)) voiceName = 'af_heart';
      voiceSel.value = voiceName;
      cloneList.replaceChildren(...v.clones.map((c) => h('div', { class: 'row' }, h('strong', {}, c), h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost sm', onclick: () => { voiceName = `clone:${c}`; voiceSel.value = voiceName; sync(); } }, 'Use'),
        h('button', { type: 'button', class: 'danger sm', onclick: async () => { try { await vfetch(`/api/voice/clone/${encodeURIComponent(c)}`, { method: 'DELETE' }); await loadVoices(); } catch (err) { toast(err.message, 'bad'); } } }, 'Remove'))));
    } catch (err) { cloneMsg.textContent = `Voice service unavailable: ${err.message}`; }
  }
  async function uploadClone(blob) {
    const name = cloneName.value.trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) { cloneMsg.textContent = 'Give the voice a short name (letters, digits, - and _).'; return; }
    cloneMsg.textContent = 'Saving sample…';
    try {
      const r = await (await vfetch(`/api/voice/clone/${encodeURIComponent(name)}`, { method: 'POST', body: blob, headers: { 'content-type': 'application/octet-stream' } })).json();
      cloneMsg.textContent = `Saved "${name}" (${r.seconds}s). The first cloned sentence takes longer while the model loads.`;
      voiceName = `clone:${name}`; await loadVoices(); sync();
    } catch (err) { cloneMsg.textContent = err.message; }
  }
  cloneRec.onclick = async () => {
    if (rec) return rec.stop();
    cloneRec.textContent = 'Stop recording'; cloneMsg.textContent = 'Recording… read something aloud for 10-30 seconds.';
    try { const b = await record({ maxMs: 30_000, stopOnSilence: false }); cloneRec.textContent = 'Record sample'; if (b) await uploadClone(b); else cloneMsg.textContent = 'Nothing heard.'; }
    catch (err) { cloneRec.textContent = 'Record sample'; cloneMsg.textContent = err.message; }
  };
  cloneFile.onchange = async () => { const f = cloneFile.files[0]; if (f) await uploadClone(f); cloneFile.value = ''; };
  speakChk.onchange = () => { speakOn = speakChk.checked; if (!speakOn) stopSpeaking(); sync(); };
  voiceSel.onchange = () => { voiceName = voiceSel.value; sync(); };
  speedIn.oninput = () => { speed = Number(speedIn.value); sync(); };
  testBtn.onclick = () => speak(voiceName.startsWith('clone:') ? 'Hello, this is how I sound now. Let me know if you like it.' : 'Hello Adam. This is how I sound. Tell me what you think.');
  closeBtn.onclick = () => dlg.close();
  settingsBtn.onclick = async () => { sync(); dlg.showModal(); await refreshStatus(); await loadVoices(); };

  async function refreshStatus() {
    try { available = (await (await vfetch('/api/voice/status')).json()).available; } catch { available = false; }
    const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    for (const b of [micBtn, talkBtn]) b.disabled = !available || !canRecord;
    uploadBtn.disabled = !available;
    if (!available) setStatus('Voice service offline');
    else if (!canRecord) setStatus('Microphone requires localhost or HTTPS');
    else if (!handsFree && !rec && !player) setStatus('');
  }
  refreshStatus();
  const refreshTimer = setInterval(() => { if (!handsFree && !rec && !player) refreshStatus(); }, 30_000);
  window.addEventListener('pagehide', () => { clearInterval(refreshTimer); handsFree = false; rec?.cancel(); stopSpeaking(); });
  sync();
  return { onReply: (text) => { if (speakOn && available && text) speak(text); }, stopSpeaking };
}
