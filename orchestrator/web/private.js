// Private chat tab. The transcript exists only in this page's memory and in the service's memory; nothing is written to
// localStorage/sessionStorage, no draft is kept, and generated files are fetched as blobs that are released on close.
// Ending the chat (button, closing the page, or 30 idle minutes) erases the service-side session and its files.
export function setupPrivate({ h, api, stream, markdown, bootstrapToken, getToken }) {
  const $ = (s) => document.querySelector(s);
  const section = h('section', { id: 'tab-private', class: 'tab page private-page' });
  $('#tab-chat').before(section);

  const route = h('select', { id: 'private-route', 'aria-label': 'Route' });
  const prompt = h('textarea', { id: 'private-prompt', rows: 3, maxlength: 12000, placeholder: 'Message (private: not saved anywhere)…', 'aria-label': 'Private message' });
  const send = h('button', { type: 'submit', class: 'primary', id: 'private-send' }, 'Send');
  const stop = h('button', { type: 'button', class: 'danger sm', id: 'private-stop', hidden: true }, 'Stop');
  const attach = h('button', { type: 'button', class: 'ghost sm', id: 'private-attach' }, 'Attach image');
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true });
  const strip = h('div', { class: 'attach-strip', hidden: true });
  const thread = h('div', { class: 'thread', id: 'private-thread', 'aria-live': 'polite' });
  const status = h('span', { class: 'muted', id: 'private-status', role: 'status' }, '');
  const erase = h('button', { type: 'button', class: 'danger sm', id: 'private-end' }, 'End chat & erase');
  const banner = h('div', { class: 'panel private-banner', role: 'note' },
    h('strong', {}, 'Private chat'),
    h('span', {}, ' · Not saved in chat history, task history, usage or memory. Local models only (nothing leaves this PC). Generated files and attachments are deleted when you end the chat, close this page, or after 30 idle minutes.'),
    h('span', { class: 'spacer' }), erase);
  const form = h('form', { class: 'composer', id: 'private-composer' }, strip, prompt,
    h('div', { class: 'composer-row' }, h('label', { class: 'sel' }, 'Route ', route), attach, file, h('span', { class: 'spacer' }), status, stop, send));
  section.append(banner, h('div', { class: 'thread-wrap' }, h('div', { class: 'thread-scroll' }, thread), form));

  let sid = null;        // service-side session id
  let pending = [];      // images waiting to be sent: { name, mediaType, data, url }
  let busy = null;       // AbortController of the running request
  let urls = [];         // blob URLs to release on close
  let routesLoaded = false;

  const welcome = () => thread.replaceChildren(h('div', { class: 'welcome' }, h('h3', {}, 'Nothing here is kept'), h('p', { class: 'muted' }, 'Ask anything. When you end the chat, the conversation and every file it made are erased.')));
  welcome();

  const scroll = () => { thread.parentElement.scrollTop = thread.parentElement.scrollHeight; };
  const bubble = (role, ...kids) => h('div', { class: `m ${role === 'user' ? 'user' : 'bot'}` }, h('div', { class: 'bubble' }, ...kids));

  async function media(name) {
    await bootstrapToken();
    const res = await fetch(`/api/private/${encodeURIComponent(sid)}/media/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`Preview unavailable (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    urls.push(url);
    return url;
  }
  function mediaEl(f) {
    const ext = f.name.split('.').pop().toLowerCase();
    const kind = /^(mp4|webm)$/.test(ext) ? 'video' : /^(mp3|wav|flac)$/.test(ext) ? 'audio' : 'img';
    const el = h(kind, kind === 'img' ? { class: 'media-preview', alt: 'Generated image' } : { class: 'media-preview', controls: true, preload: 'metadata' });
    const note = h('span', { class: 'muted' }, 'Loading preview…');
    const wrap = h('figure', { class: 'media-card' }, el, note);
    media(f.name).then((url) => { el.src = url; note.replaceChildren(h('a', { href: url, download: f.name }, 'Download')); }, (e) => { note.textContent = e.message; });
    return wrap;
  }

  function renderStrip() {
    strip.hidden = !pending.length;
    strip.replaceChildren(...pending.map((p, i) => h('span', { class: 'chip' }, p.name, h('button', { type: 'button', class: 'ghost sm', onclick: () => { pending.splice(i, 1); renderStrip(); } }, '×'))));
  }
  attach.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    for (const f of file.files) {
      if (pending.length >= 4) break;
      const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = bad; r.readAsDataURL(f); });
      pending.push({ name: f.name, mediaType: f.type, data });
    }
    file.value = '';
    renderStrip();
  });

  async function endSession({ silent = false } = {}) {
    busy?.abort();
    const id = sid;
    sid = null; pending = []; busy = null;
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    prompt.value = '';
    renderStrip();
    welcome();
    status.textContent = '';
    stop.hidden = true; send.disabled = false;
    if (id) await api(`/api/private/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    if (!silent) status.textContent = 'Chat erased.';
  }
  erase.addEventListener('click', () => endSession());

  // Closing or reloading the page ends the session (keepalive lets the request outlive the page).
  window.addEventListener('pagehide', () => {
    if (!sid) return;
    try { fetch(`/api/private/${encodeURIComponent(sid)}`, { method: 'DELETE', keepalive: true, headers: { authorization: `Bearer ${getToken()}` } }); } catch { /* the idle timeout removes it */ }
  });

  stop.addEventListener('click', () => busy?.abort());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = prompt.value.trim();
    if (!text || busy) return;
    const images = pending;
    pending = []; renderStrip(); prompt.value = '';
    thread.querySelector('.welcome')?.remove();
    thread.append(bubble('user', h('p', {}, text), images.length ? h('p', { class: 'muted' }, `[${images.length} image${images.length > 1 ? 's' : ''} attached]`) : ''));
    const body = h('div', {}, h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
    const live = bubble('bot', body);
    thread.append(live);
    scroll();
    busy = new AbortController();
    const mine = busy;
    send.disabled = true; stop.hidden = false; status.textContent = 'Starting…';
    let acc = '';
    try {
      if (!sid) sid = (await api('/api/private', { method: 'POST', body: {} })).id;
      const r = await stream(`/api/private/${encodeURIComponent(sid)}/chat`, { prompt: text, taskType: route.value, images: images.length ? images.map(({ name, mediaType, data }) => ({ name, mediaType, data })) : undefined }, (ev) => {
        if (ev.type === 'routed') status.textContent = `${ev.reason ?? 'routed'}…`;
        else if (ev.type === 'attempt') { acc = ''; status.textContent = `${ev.connector} · ${ev.model}…`; }
        else if (ev.type === 'delta') { acc += ev.text; body.replaceChildren(markdown(acc)); scroll(); }
        else if (ev.type === 'attempt-failed') status.textContent = `${ev.connector} failed (${ev.error}); trying next…`;
      }, mine.signal);
      const reply = r.reply;
      body.replaceChildren(reply.ok ? markdown(reply.text || '') : h('p', { class: 'bad' }, reply.error ?? 'No answer'));
      if (reply.files?.length) body.append(h('div', { class: 'inline-media' }, reply.files.map(mediaEl)));
      status.textContent = reply.ok ? `${reply.connector ?? ''} · ${((reply.ms ?? 0) / 1000).toFixed(1)}s` : '';
    } catch (err) {
      if (mine.signal.aborted && !sid) return; // chat was ended while running
      const stopped = err.name === 'AbortError';
      body.replaceChildren(h('p', { class: stopped ? 'muted' : 'bad' }, stopped ? 'Stopped' : err.message));
      status.textContent = '';
      if (!stopped) prompt.value = text;
    } finally {
      if (busy === mine) busy = null;
      stop.hidden = true; send.disabled = false;
      scroll();
    }
  });
  prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });

  return async () => {
    if (routesLoaded) return;
    const cfg = await api('/api/config');
    const local = (name) => ['ollama', 'comfyui'].includes(cfg.connectors[name]?.kind);
    const names = Object.entries(cfg.routes).filter(([, r]) => !r.agent && r.chain.some(local)).map(([n]) => n);
    route.replaceChildren(...names.map((n) => h('option', { value: n }, n)));
    route.value = names.includes('general') ? 'general' : names[0] ?? '';
    routesLoaded = true;
  };
}
