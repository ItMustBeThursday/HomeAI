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
  cancel.addEventListener('click', async () => {
    if (!runId) return;
    cancel.disabled = true;
    try { await api(`/api/runs/${runId}/cancel`, { method:'POST', body:{} }); status.textContent = 'Stopping generation...'; }
    catch (e) { showError(e); cancel.disabled = false; }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (runId || !prompt.value.trim()) return;
    const params = {};
    for (const [k,input] of Object.entries(fields)) if (!input.parentElement.hidden && input.value !== '') params[k] = Number(input.value);
    if (mode.value === 'audio') params.lyrics = lyrics.value;
    else params.negative = negative.value;
    runId = crypto.randomUUID();
    status.classList.remove('bad'); form.classList.add('generating');
    generate.disabled = true; cancel.hidden=false; cancel.disabled = false; mode.disabled = true; model.disabled = true;
    const start = Date.now();
    const update = () => { status.textContent = `Generating locally - ${Math.floor((Date.now()-start)/1000)} seconds. You can use other tabs while it runs.`; };
    update(); const timer = setInterval(update,1000);
    try {
      const result = await stream('/api/task', { taskType:mode.value === 'audio' ? 'music' : mode.value, connector:model.value, prompt:prompt.value.trim(), params, runId });
      if (!result.ok) throw new Error(result.error || 'Generation failed; see History for details.');
      clearInterval(timer);
      status.textContent = `Saved ${result.files?.length ?? 0} file(s) in ${((Date.now()-start)/1000).toFixed(1)} seconds.`;
      await loadGallery();
    } catch(e) { clearInterval(timer); showError(e); }
    finally { runId=null; form.classList.remove('generating'); generate.disabled=!model.value; cancel.hidden=true; mode.disabled=false; model.disabled=false; }
  });
  return async () => {
    const config = await api('/api/config'); connectors = config.connectors;
    if (!runId) models();
    await loadGallery();
  };
}
