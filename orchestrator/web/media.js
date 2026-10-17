// Local generation studio. Authenticated blobs keep tokens out of media URLs.
export function setupMedia({ h, api, stream, mediaView }) {
  const $ = (s) => document.querySelector(s);
  const section = h('section', { id: 'tab-media', class: 'tab page studio-page' });
  $('#tab-chat').before(section);
  const mode = h('select', { id: 'media-mode', 'aria-label': 'Media type' }, h('option', { value: 'video' }, 'Video'), h('option', { value: 'audio' }, 'Music'), h('option', { value:'image' }, 'Image'));
  const model = h('select', { id: 'media-model', 'aria-label': 'Generation model' });
  const prompt = h('textarea', { id: 'media-prompt', rows: 4, required: true, maxlength: 12000, placeholder: 'Describe the scene, subject and motion, or a musical style and instruments.' });
  const lyrics = h('textarea', { id: 'media-lyrics', rows: 3, maxlength: 3000, placeholder: 'Optional lyrics; leave empty for instrumental music.' });
  const fields = {};
  const labels = { width: 'Width', height: 'Height', frames: 'Frames', fps: 'FPS', steps: 'Steps', cfg: 'Guidance', seconds: 'Seconds', bpm: 'BPM', seed: 'Seed (blank = random)' };
  const limits = { width: [256,1280,32], height: [256,1280,32], frames: [9,121,8], fps: [8,30,1], steps: [1,50,1], cfg: [.5,10,.1], seconds: [5,120,1], bpm: [40,200,1], seed: [0,2147483647,1] };
  const settings = h('div', { class: 'media-settings' });
  for (const [key, [min,max,step]] of Object.entries(limits)) {
    fields[key] = h('input', { type: 'number', id: `media-${key}`, min, max, step });
    settings.append(h('label', { 'data-media-setting': key }, labels[key], fields[key]));
  }
  const lyricsLabel = h('label', {}, 'Lyrics', lyrics);
  const negative = h('textarea', { id: 'media-negative', rows: 2, maxlength: 500, placeholder: 'Optional: blur, distorted anatomy, camera shake...' });
  const negLabel = h('label', {}, 'Negative prompt', negative);
  const generate = h('button', { id: 'media-generate', class: 'primary', type: 'submit' }, 'Generate');
  const cancel = h('button', { id: 'media-cancel', class: 'ghost', type: 'button', hidden: true }, 'Stop generation');
  const status = h('p', { id: 'media-status', role: 'status', 'aria-live': 'polite' }, 'Ready. Generation runs locally and can take several minutes.');
  const gallery = h('div', { id: 'media-gallery', class: 'media-gallery' });
  const modelNote = h('p', { class:'model-note muted', role:'status' });
  const advanced = h('details', { class:'studio-advanced' }, h('summary', {}, 'Generation settings'), negLabel, settings);
  const form = h('form', { class: 'panel media-form' }, h('div', { class:'studio-form-head' }, h('h3', {}, 'Create something new'), h('span', {class:'pill ok'}, 'Local generation')), h('div', { class: 'studio-models' }, h('label', {}, 'Format', mode), h('label', {}, 'Model', model)), modelNote, h('label', {}, 'Your idea', prompt), lyricsLabel, advanced, h('div', { class: 'studio-submit' }, status, generate, cancel));
  const filter = h('select', {id:'media-filter', 'aria-label':'Filter library'}, h('option', {value:''}, 'All media'), h('option', {value:'video'}, 'Videos'), h('option', {value:'audio'}, 'Music'), h('option', {value:'image'}, 'Images'));
  const libraryCount = h('span', {class:'muted'});
  const more = h('button', {class:'ghost', hidden:true, onclick:()=>{visibleLimit+=12; renderGallery();}}, 'Show more');
  section.append(h('div', {class:'studio-heading'}, h('div', {}, h('span', {class:'eyebrow'}, 'HOMEAI STUDIO'), h('h2', {}, 'Bring your ideas to life'), h('p', {class:'muted'}, 'Make a film. Find a sound. Create right here on your PC.'))), form, h('div', { class: 'library-head' }, h('h2', {}, 'Your library'), libraryCount, h('span', {class:'spacer'}), filter, h('button', { class: 'ghost sm', onclick: () => loadGallery().catch(showError) }, 'Refresh library')), gallery, more);
  let connectors = {}, runId = null;
  let libraryFiles = [], visibleLimit = 12, galleryVersion = 0;
  function showError(e) { status.textContent = e.message; status.classList.add('bad'); }
  function defaults() {
    const d = connectors[model.value]?.defaults ?? {};
    for (const [k, input] of Object.entries(fields)) input.value = d[k] ?? (k === 'seed' ? '' : ({ frames:49,width:640,height:352,steps:20,fps:24,cfg:5,seconds:30,bpm:110 })[k]);
    modelNote.textContent = /UNTESTED/i.test(connectors[model.value]?.model ?? '') ? 'Experimental model: quality and runtime are not yet verified on this PC.' : 'Runs on your GPU. Larger clips take longer; start with the recommended settings.';
  }
  function models() {
    const old = model.value;
    model.replaceChildren(...Object.entries(connectors).filter(([,c]) => c.kind === 'comfyui' && c.media === mode.value).map(([id,c]) => h('option', { value:id }, c.model.replace(/ \((?:tested|UNTESTED workflow)\)/g, '').replace('fp16 weights cast to fp8, tested','FP8 · recommended'))));
    if ([...model.options].some(o => o.value === old)) model.value = old;
    const video = mode.value === 'video', image = mode.value === 'image';
    for (const label of settings.children) label.hidden = !(['steps','seed', ...(video ? ['cfg','width','height','frames','fps'] : image ? ['width','height'] : ['cfg','seconds','bpm'])].includes(label.dataset.mediaSetting));
    lyricsLabel.hidden = mode.value !== 'audio';
    negLabel.hidden = !video;
    generate.disabled = !!runId || !model.value;
    defaults();
  }
  mode.addEventListener('change', models);
  model.addEventListener('change', defaults);
  filter.addEventListener('change', ()=>{visibleLimit=12; renderGallery();});
  function renderGallery() {
    const files = libraryFiles.filter(f=>!filter.value || f.type.startsWith(filter.value+'/'));
    gallery.replaceChildren(...files.slice(0,visibleLimit).map(mediaView));
    libraryCount.textContent = `${files.length} ${files.length === 1 ? 'creation' : 'creations'}`;
    more.hidden=files.length<=visibleLimit;
    if (!files.length) gallery.append(h('div', {class:'library-empty'}, h('div', {class:'empty-symbol','aria-hidden':true}, '◇'), h('h3', {}, 'A little imagination starts here'), h('p', {class:'muted'}, 'Your videos, images and music will appear here, ready to play and share.')));
  }
  async function loadGallery() {
    const version = ++galleryVersion;
    const { files } = await api('/api/media');
    if(version !== galleryVersion) return;
    libraryFiles = files;
    renderGallery();
  }
  // ---- persistent studio chat: one saved conversation (shared store), survives tab switches, refresh and restarts ----
  const KEY = 'homeai-studio-conversation';
  let convId = localStorage.getItem(KEY) || null, watching = false, timer = null, startedAt = 0;
  const thread = h('div', { id: 'studio-thread', class: 'studio-thread', 'aria-live': 'polite' });
  const newChat = h('button', { class: 'ghost sm', type: 'button', onclick: () => { if (runId || watching) return; convId = null; localStorage.removeItem(KEY); renderThread(null); } }, 'New studio chat');
  const threadHead = h('div', { class: 'library-head studio-thread-head' }, h('h2', {}, 'Studio chat'), h('span', { class: 'muted' }, 'Saved automatically; also listed under Chats'), h('span', { class: 'spacer' }), newChat);
  form.after(threadHead, thread);
  function renderThread(conv) {
    const msgs = conv?.messages ?? [];
    thread.replaceChildren(...msgs.map((m) => m.role === 'user'
      ? h('div', { class: 'm user' }, h('div', { class: 'bubble' }, m.text))
      : h('div', { class: `m bot${m.error ? ' error' : ''}` }, h('div', { class: 'bubble' },
          m.error ? h('p', {}, m.error) : (m.text ? h('p', {}, m.text) : null),
          m.files?.length ? h('div', { class: 'inline-media' }, m.files.map(mediaView)) : null))));
    if (!msgs.length) thread.append(h('p', { class: 'muted studio-thread-empty' }, 'Your requests and results will stay here, even if you leave this page.'));
    thread.scrollTop = thread.scrollHeight;
  }
  async function fetchConv() {
    if (!convId) return null;
    try { return await api(`/api/conversations/${encodeURIComponent(convId)}`); }
    catch (e) { if (/not found|404/i.test(e.message)) { convId = null; localStorage.removeItem(KEY); return null; } throw e; }
  }
  function setBusy(on) {
    form.classList.toggle('generating', on);
    generate.disabled = on || !model.value; cancel.hidden = !on; cancel.disabled = false; mode.disabled = on; model.disabled = on;
  }
  // After a refresh or a dropped connection the service keeps generating; follow the saved run instead of re-sending.
  function watchRun(conv) {
    if (watching) return;
    watching = true; runId = conv.run?.runId ?? runId; startedAt = conv.run?.started ?? Date.now();
    setBusy(true); status.classList.remove('bad');
    const tick = async () => {
      status.textContent = `Generating locally - ${Math.floor((Date.now() - startedAt) / 1000)} seconds. You can leave this page; the result is saved to this chat.`;
      let cur = null;
      try { cur = await fetchConv(); } catch { /* temporary; keep waiting */ }
      if (cur) renderThread(cur);
      if (!cur || cur.run?.status !== 'running') {
        watching = false; runId = null; setBusy(false);
        const last = cur?.messages?.at(-1);
        if (last?.error) showError(new Error(last.error)); else status.textContent = 'Finished. The result is in your studio chat and library.';
        await loadGallery().catch(showError);
        return;
      }
      timer = setTimeout(tick, 3000);
    };
    tick();
  }
  async function loadSession() {
    const conv = await fetchConv();
    renderThread(conv);
    if (conv?.run?.status === 'running' && !runId) watchRun(conv);
  }
  cancel.addEventListener('click', async () => {
    if (!runId) return;
    cancel.disabled = true;
    try { await api(`/api/runs/${runId}/cancel`, { method:'POST', body:{} }); status.textContent = 'Stopping generation...'; }
    catch (e) { showError(e); cancel.disabled = false; }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (runId || watching || !prompt.value.trim()) return;
    const params = {};
    for (const [k,input] of Object.entries(fields)) if (!input.parentElement.hidden && input.value !== '') params[k] = Number(input.value);
    if (mode.value === 'audio') params.lyrics = lyrics.value;
    else params.negative = negative.value;
    runId = crypto.randomUUID();
    const text = prompt.value.trim();
    status.classList.remove('bad'); setBusy(true);
    const start = Date.now();
    const update = () => { status.textContent = `Generating locally - ${Math.floor((Date.now()-start)/1000)} seconds. You can use other tabs while it runs.`; };
    update(); const clock = setInterval(update,1000);
    thread.querySelector('.studio-thread-empty')?.remove();
    thread.append(h('div', { class: 'm user' }, h('div', { class: 'bubble' }, text)));
    thread.scrollTop = thread.scrollHeight;
    let reached = false;
    try {
      const result = await stream('/api/chat', { conversationId: convId ?? undefined, taskType:mode.value === 'audio' ? 'music' : mode.value, connector:model.value, prompt:text, params, runId }, (ev) => {
        reached = true;
        if (ev.type === 'conversation') { convId = ev.id; localStorage.setItem(KEY, convId); }
      });
      clearInterval(clock);
      const files = result.reply?.files?.length ?? 0;
      if (result.reply && result.reply.ok === false) throw new Error(result.reply.error || 'Generation failed; see History for details.');
      status.textContent = `Saved ${files} file(s) in ${((Date.now()-start)/1000).toFixed(1)} seconds.`;
      runId = null;
      renderThread(await fetchConv());
      await loadGallery();
    } catch(e) {
      clearInterval(clock);
      const dropped = reached && convId && (e.name === 'TypeError' || /Stream ended without a result/.test(e.message));
      if (dropped) {
        const conv = await fetchConv().catch(() => null);
        if (conv?.run?.status === 'running') { runId = null; watchRun(conv); return; }
        runId = null; renderThread(conv);
        const last = conv?.messages?.at(-1);
        if (last?.error) showError(new Error(last.error)); else status.textContent = 'Finished. The result is in your studio chat.';
        await loadGallery().catch(() => {});
      } else { showError(e); if (convId) renderThread(await fetchConv().catch(() => null)); }
    }
    finally { if (!watching) { runId = null; setBusy(false); } }
  });
  return async () => {
    const config = await api('/api/config'); connectors = config.connectors;
    if (!runId && !watching) models();
    await Promise.all([loadGallery(), loadSession()]);
  };
}
