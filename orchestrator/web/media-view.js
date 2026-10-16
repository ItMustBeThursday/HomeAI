// One media renderer for chat and the library. Credentials never appear in URLs.
export function localMediaName(value) {
  const match = /^(?:\/api\/media\/)?([a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:mp4|webm|mp3|wav|flac|png|jpg|webp|gif))$/i.exec(value ?? '');
  return match?.[1] ?? null;
}
export function createMediaRenderer({ h, bootstrapToken, getToken }) {
  const active = new Map();
  const pending = new Map();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      observer.unobserve(entry.target);
      const load = pending.get(entry.target); pending.delete(entry.target); load?.();
    }
  }, { rootMargin:'160px' });
  // Release blobs and in-flight requests when a chat/library is replaced.
  new MutationObserver(() => {
    for (const [node, dispose] of active) if (!node.isConnected) { dispose(); active.delete(node); }
    for (const node of pending.keys()) if (!node.isConnected) { observer.unobserve(node); pending.delete(node); }
  }).observe(document.body, { childList:true, subtree:true });
  return function mediaView(file) {
    const name = localMediaName(file.name);
    if (!name) return h('span', {}, 'Media unavailable');
    const ext = name.split('.').pop().toLowerCase();
    const kind = /^(mp4|webm)$/.test(ext) ? 'video' : /^(mp3|wav|flac)$/.test(ext) ? 'audio' : 'img';
    const title = name.replace(/^[a-f0-9]{8}-/i,'').replace(/_\d+_?(?=\.)/,'').replace(/_/g,' ');
    const player = h(kind, { class:'media-preview', ...(kind === 'img' ? { alt:title, loading:'lazy' } : { controls:true, preload:'metadata', playsinline:true }), 'aria-label':title });
    const note = h('span', { class:'media-loading', role:'status' }, 'Loading preview...');
    const download = h('a', { class:'media-download', download:name, hidden:true }, 'Download');
    const card = h('figure', { class:`media-card media-${kind}` }, h('div', { class:'media-stage' }, player, note), h('figcaption', {}, h('div', { class:'media-caption' }, h('strong', { title:name }, title), h('span', { class:'muted' }, [kind === 'img' ? 'Image' : kind === 'video' ? 'Video' : 'Music', file.size ? `${(file.size/1048576).toFixed(1)} MB` : '', file.ts ? new Date(file.ts).toLocaleDateString() : ''].filter(Boolean).join(' · '))), download));
    let url, controller;
    const load = async () => {
      note.hidden = false; note.textContent = 'Loading preview...';
      controller = new AbortController();
      active.set(card, () => { controller.abort(); if(url) URL.revokeObjectURL(url); });
      try {
        await bootstrapToken();
        const res = await fetch(`/api/media/${encodeURIComponent(name)}`, { headers:{ authorization:`Bearer ${getToken()}` }, signal:controller.signal });
        if (!res.ok) throw new Error(`Preview unavailable (${res.status})`);
        const blob = await res.blob();
        if (!card.isConnected) return;
        url = URL.createObjectURL(blob); player.src = url; download.href = url; download.hidden = false; note.hidden = true;
      } catch(e) {
        if(e.name === 'AbortError') return;
        note.replaceChildren(h('span', {}, e.message), h('button', { type:'button', class:'ghost sm', onclick:load }, 'Retry preview'));
      }
    };
    player.addEventListener('error', () => { note.hidden=false; note.textContent='This browser cannot preview this file. You can download it below.'; });
    pending.set(card, load);
    // Wait until the caller has attached the element to its document.
    queueMicrotask(() => { if(card.isConnected) observer.observe(card); else pending.delete(card); });
    return card;
  };
}
