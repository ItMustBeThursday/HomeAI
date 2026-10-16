// HomeAI Orchestrator WebUI. Plain ES module, no build step.
// Safety rule: model/user text is only ever inserted with textContent or createTextNode, never innerHTML.
// (The only innerHTML use is the static icon table below.)
import { setupMedia } from './media.js';
import { createMediaRenderer, localMediaName } from './media-view.js';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = new Intl.NumberFormat();
const n = (v) => fmt.format(v ?? 0);
const secs = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`);
const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const sum = (attempts) => (attempts ?? []).reduce((s, a) => s + (a.inputTokens || 0) + (a.outputTokens || 0), 0);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// ---- Icons (static markup only) ----
const ICONS = {
  plug: '<path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  terminal: '<path d="M4 5h16v14H4z"/><path d="M7 10l3 2-3 2M12 15h5"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V4a3 3 0 0 0-3 0zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  devices: '<rect x="3" y="5" width="13" height="10" rx="1.5"/><path d="M8 19h3M9.5 15v4"/><rect x="18" y="8" width="3" height="9" rx="1"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/><path d="M18 15l3 3-3 3"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/>',
};
function icon(name) {
  const s = h('span', { class: 'ico' });
  s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return s;
}
function paintIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    if (el.dataset.painted) continue;
    el.dataset.painted = '1';
    el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[el.dataset.icon] ?? ''}</svg>`;
  }
}

// ---- Persistent UI settings ----
const DEFAULTS = { theme: 'system', accent: '#4f6bed', density: 'comfortable', width: 'normal', enterSends: true, showMeta: true, collapsed: false, sideW: 0 };
const ui = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('homeai-ui') || '{}') };
const saveUi = () => localStorage.setItem('homeai-ui', JSON.stringify(ui));
function applyUi() {
  const r = document.documentElement;
  r.dataset.theme = ui.theme;
  r.dataset.density = ui.density === 'compact' ? 'compact' : '';
  r.dataset.width = ui.width === 'normal' ? '' : ui.width;
  r.style.setProperty('--accent', ui.accent);
  $('#app').classList.toggle('collapsed', ui.collapsed);
  applySideWidth();
  paintThemeButton();
}
const SIDE_MIN = 200;
const SIDE_MAX = 560;
function applySideWidth() {
  const w = Math.round(Number(ui.sideW));
  document.documentElement.style.setProperty('--side-w', w >= SIDE_MIN ? `${Math.min(w, SIDE_MAX)}px` : '');
}
function paintThemeButton() {
  const b = $('#top-theme');
  if (!b) return;
  const dark = ui.theme === 'dark' || (ui.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[dark ? 'moon' : 'sun']}</svg>`;
  b.title = `Theme: ${ui.theme} (click to change)`;
}
const ACCENTS = ['#4f6bed', '#7c5cf0', '#0e9f8e', '#d9534f', '#d98a00', '#2f855a', '#3d3f4a'];

// ---- Toasts & dialogs ----
function toast(text, kind = '', action = null) {
  const t = h('div', { class: `toast ${kind}` }, text);
  if (action) t.append(h('button', { class: 'ghost tact', onclick: () => { t.remove(); action.run(); } }, action.label));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), action ? 9000 : kind === 'bad' ? 7000 : 3500);
}
function ask(title, message, value = '') {
  return new Promise((resolve) => {
    const dlg = $('#input-dialog');
    $('#input-title').textContent = title;
    $('#input-msg').textContent = message ?? '';
    const f = $('#input-field');
    f.value = value;
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? f.value : null), { once: true });
    dlg.returnValue = '';
    dlg.showModal();
    f.focus();
    f.select();
  });
}
$('#input-cancel').addEventListener('click', () => $('#input-dialog').close('cancel'));
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  toast('Copied', 'ok');
}
const download = (name, text, type = 'text/markdown') => {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
};

// ---- API ----
let token = localStorage.getItem('homeai-token') || '';

async function api(path, { method = 'GET', body } = {}) {
  await bootstrapToken();
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (res.status === 401) {
    await askToken();
    if (!token) throw new Error('An access token is required');
    return api(path, { method, body });
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function bootstrapToken() {
  if (token) return;
  try {
    const r = await fetch('/api/bootstrap');
    if (r.ok) token = (await r.json()).token || '';
  } catch { /* ignore */ }
}

// POST that reads a server-sent-event stream. Resolves with the 'done' event.
async function stream(path, body, onEvent, signal) {
  await bootstrapToken();
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }), signal });
  if (res.status === 401) { await askToken(); return stream(path, body, onEvent, signal); }
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let final = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'error') throw new Error(ev.error);
      if (ev.type === 'done') final = ev;
      onEvent?.(ev);
    }
  }
  if (!final) throw new Error('Stream ended without a result');
  return final;
}

function askToken() {
  return new Promise((resolve) => {
    const dlg = $('#token-dialog');
    $('#token-input').value = '';
    dlg.addEventListener('close', () => {
      token = $('#token-input').value.trim();
      localStorage.setItem('homeai-token', token);
      resolve();
    }, { once: true });
    dlg.showModal();
  });
}

// ---- Markdown (DOM-built, no innerHTML) ----
const mediaView = createMediaRenderer({ h, bootstrapToken, getToken: () => token });
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\s][^*\n]*\*)|(!?\[[^\]\n]*\]\((?:https?:\/\/|\/api\/media\/)[^)\s]+\))|(https?:\/\/[^\s<>)\]]+)/g;
function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (m[1]) out.push(h('code', {}, s.slice(1, -1)));
    else if (m[2] || m[3]) out.push(h('strong', {}, inline(s.slice(2, -2))));
    else if (m[4]) out.push(h('del', {}, inline(s.slice(2, -2))));
    else if (m[5]) out.push(h('em', {}, inline(s.slice(1, -1))));
    else if (m[6]) {
      const [, label, url] = /^!?\[([^\]]*)\]\((.+)\)$/.exec(s);
      const name = url.startsWith('/api/media/') && localMediaName(url);
      out.push(name ? mediaView({ name }) : h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label || url));
    } else out.push(h('a', { href: s, target: '_blank', rel: 'noopener noreferrer' }, s));
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
const withBreaks = (lines) => lines.flatMap((l, i) => (i ? [h('br'), ...inline(l)] : inline(l)));

function codeBlock(lang, code) {
  const copy = h('button', { type: 'button', class: 'ghost', onclick: (e) => { copyText(code); e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1200); } }, 'Copy');
  return h('div', { class: 'codeblock' }, h('header', {}, h('span', {}, lang || 'text'), copy), h('pre', {}, h('code', {}, code)));
}

function markdown(src) {
  const root = h('div', { class: 'md' });
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  const isBlockStart = (l) => /^(#{1,4}\s|```|>\s?|\s*([-*+]|\d+\.)\s|(-{3,}|\*{3,})\s*$)/.test(l);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^```(\S*)/.exec(line))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      root.append(codeBlock(m[1], buf.join('\n')));
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      root.append(h(`h${m[1].length}`, {}, inline(m[2])));
      i++;
    } else if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      root.append(h('hr'));
      i++;
    } else if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      root.append(h('blockquote', {}, h('p', {}, withBreaks(buf))));
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(h('li', {}, inline(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ''))));
      root.append(h(ordered ? 'ol' : 'ul', {}, items));
    } else if (line.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      root.append(h('table', {}, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, inline(c))))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, inline(c))))))));
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i]))) buf.push(lines[i++]);
      root.append(h('p', {}, withBreaks(buf)));
    }
  }
  return root;
}

// ---- Navigation ----
const TABS = [
  { id: 'chat', label: 'Chat', icon: 'chat', group: 'Workspace' },
  { id: 'media', label: 'Media studio', icon: 'tv', group: 'Workspace' },
  { id: 'jobs', label: 'Jobs', icon: 'queue', group: 'Workspace', feature: 'jobs', admin: true },
  { id: 'overview', label: 'Overview', icon: 'grid', group: 'Workspace' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal', group: 'Build', feature: 'shell', admin: true },
  { id: 'projects', label: 'Projects', icon: 'folder', group: 'Build', feature: 'shell', admin: true },
  { id: 'memory', label: 'Memory', icon: 'brain', group: 'Build', feature: 'memory' },
  { id: 'usage', label: 'Usage', icon: 'chart', group: 'Observe' },
  { id: 'history', label: 'History', icon: 'clock', group: 'Observe' },
  { id: 'status', label: 'Status', icon: 'pulse', group: 'Observe' },
  { id: 'schedule', label: 'Schedule', icon: 'calendar', group: 'Observe' },
  { id: 'config', label: 'Config', icon: 'cog', group: 'Admin' },
  { id: 'connections', label: 'Connections', icon: 'plug', group: 'Admin', feature: 'connections', admin: true },
  { id: 'devices', label: 'Devices', icon: 'devices', group: 'Admin', feature: 'devices', admin: true },
  { id: 'logan', label: 'Logan', icon: 'tv', group: 'Admin' },
];
const TITLES = { ...Object.fromEntries(TABS.map((t) => [t.id, t.label])), chats: 'All chats', settings: 'Settings' };
const SUBS = {
  chat: 'Route-aware conversations', chats: 'Open, archive, delete and restore conversations', jobs: 'Queue work and walk away', overview: 'Everything at a glance', terminal: 'Interactive shells, any folder', projects: 'Tests, git and GitHub',
  memory: 'Durable facts the models can see', usage: 'Informational tokens and calls', history: 'Every task and its fallbacks', status: 'Backend and model health',
  schedule: 'Timed jobs and the request queue', config: 'Routes, connectors and budgets', connections: 'Logins for GitHub and other services', devices: 'Tokens for phones and displays', logan: 'Menu catalog (coming)', settings: 'Appearance and shortcuts',
};

const convPanel = $('#conv-panel');
const convOpenNow = () => ui.convOpen !== false;
function applyConvPanel() {
  const open = convOpenNow();
  convPanel.hidden = !open;
  $('#conv-toggle')?.setAttribute('aria-expanded', String(open));
  $('#conv-toggle')?.classList.toggle('open', open);
}
function buildNav() {
  const nav = $('#tabs');
  nav.replaceChildren();
  let group = '';
  for (const t of TABS) {
    if (t.group !== group) { group = t.group; nav.append(h('div', { class: 'nav-group' }, group)); }
    const btn = h('button', { class: 'nav-item', 'data-tab': t.id === 'chat' ? 'chats' : t.id, 'data-nav': t.id, 'data-feature': t.feature, 'data-admin': t.admin ? '1' : null, title: t.label }, icon(t.icon), h('span', { class: 'lbl' }, t.label));
    if (t.id !== 'chat') { nav.append(btn); continue; }
    btn.title = 'All chats: open, archive or delete';
    // Chat: a row with a chevron that drops down the conversation list right under it.
    const chev = h('button', { id: 'conv-toggle', class: 'chev', title: 'Show or hide conversations', 'aria-label': 'Show or hide conversations', 'aria-expanded': 'false' }, '▾');
    chev.addEventListener('click', () => { ui.convOpen = !convOpenNow(); saveUi(); applyConvPanel(); });
    nav.append(h('div', { class: 'nav-row' }, btn, chev), convPanel);
  }
  applyConvPanel();
  $('#collapse').append(icon('panel'));
  $('#menu').append(icon('menu'));
}

const loaders = {};
loaders.media = setupMedia({ h, api, stream, mediaView });
let current = 'chat';
function show(tab) {
  if (!TITLES[tab]) tab = 'chat';
  current = tab;
  for (const b of $$('[data-tab]')) if (b.classList.contains('nav-item')) b.classList.toggle('active', b.dataset.tab === tab || (tab === 'chat' && b.dataset.tab === 'chats'));
  for (const s of $$('.tab')) s.classList.toggle('active', s.id === `tab-${tab}`);
  $('#page-title').textContent = TITLES[tab];
  $('#page-sub').textContent = SUBS[tab] ?? '';
  document.title = `${TITLES[tab]} · HomeAI`;
  history.replaceState(null, '', `#${tab}`);
  $('#app').classList.remove('menu-open');
  $('#scrim').hidden = true;
  loaders[tab]?.().catch((err) => toast(err.message, 'bad'));
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab],[data-go]');
  if (b) show(b.dataset.tab || b.dataset.go);
});

// ---- Health ----
async function health() {
  const el = $('#health');
  try {
    const r = await fetch('/api/health').then((x) => x.json());
    el.className = 'health ok';
    el.textContent = `v${r.version} · online`;
  } catch {
    el.className = 'health bad';
    el.textContent = 'offline';
  }
}

// ---- Config cache ----
let config = null;
let whoami = null;
// Chats on this PC start on "auto": a cheap check on each message picks answer / do / plan. Limited devices use the default.
const canAct = () => config.features.shell && whoami?.scopes.includes('admin');
const routeExists = (r) => !!config && (r === 'auto' ? !!config.auto : Object.hasOwn(config.routes, r));
function startRoute() {
  if (!canAct()) return config.default;
  return config.auto ? 'auto' : config.routes.agent ? 'agent' : config.default;
}
async function loadConfig() {
  config = await api('/api/config');
  const route = $('#route');
  const prevRoute = route.value;
  route.replaceChildren(
    ...(config.auto ? [h('option', { value: 'auto' }, 'auto (checks each message)')] : []),
    ...Object.keys(config.routes).map((r) => h('option', { value: r }, r === config.default ? `${r} (default)` : r)),
  );
  route.value = prevRoute && routeExists(prevRoute) ? prevRoute : startRoute();
  const pin = $('#pin');
  const prevPin = pin.value;
  pin.replaceChildren(h('option', { value: '' }, 'Automatic'), ...Object.entries(config.connectors).map(([name, c]) => h('option', { value: name, title:c.model }, name)));
  pin.value = prevPin && config.connectors[prevPin] ? prevPin : '';
  syncModels();
  return config;
}
function syncModels() {
  if (!config) return;
  const route = config.routes[$('#route').value];
  const media = route?.chain.map(id=>config.connectors[id]).find(c=>c.kind==='comfyui')?.media;
  for(const option of $('#pin').options) {
    const c=config.connectors[option.value];
    option.disabled = !!c && (media ? c.kind!=='comfyui' || c.media!==media : c.kind==='comfyui' || (route?.agent && !['claude-cli','codex-cli'].includes(c.kind)));
    option.hidden=option.disabled;
  }
  if ($('#pin').selectedOptions[0]?.disabled) $('#pin').value='';
  $('#pin').title='Preferred model. Compatible route models are tried if it is unavailable.';
}

function applyFeatures() {
  const f = config?.features ?? {};
  const isAdmin = whoami?.scopes.includes('admin');
  for (const el of $$('[data-feature]')) {
    const k = el.dataset.feature;
    el.hidden = !f[k] || (el.dataset.admin && !isAdmin);
  }
  // Hide a group header when all its items are hidden.
  $$('.nav-group').forEach((g) => {
    let el = g.nextElementSibling;
    let any = false;
    while (el && !el.classList.contains('nav-group')) { if (!el.hidden) any = true; el = el.nextElementSibling; }
    g.hidden = !any;
  });
  const chip = $('#who');
  chip.hidden = !whoami;
  if (whoami) chip.textContent = `${whoami.name} · ${whoami.scopes.includes('admin') ? 'admin' : whoami.scopes.join(', ')}`;
}

// ---- Chat state ----
let convId = null;
let sending = false;
let convs = [];
let msgs = []; // messages currently in the thread: { role, text, ... }
let pins = new Set(JSON.parse(localStorage.getItem('homeai-pins') || '[]'));
const savePins = () => localStorage.setItem('homeai-pins', JSON.stringify([...pins]));
const SUGGESTIONS = [
  ['Summarize', 'Summarize the key points of the text I paste next.', 'fast, cheap route'],
  ['Review code', 'Review this code for bugs and suggest fixes:\n\n', 'coder route'],
  ['Check the project', 'Run the tests in the current project and tell me what fails.', 'agent route, needs a project'],
  ['Plan a feature', 'Help me plan the next feature for the orchestrator step by step.', 'general route'],
  ['Reorganise files', 'Look at how this project folder is laid out and plan a cleaner structure. ', 'plan route: look, propose, then you approve', 'plan'],
];

function botMeta(m) {
  const meta = h('div', { class: 'meta' });
  const bits = [];
  if (m.connector) bits.push(h('span', { class: 'pill' }, `${m.connector} · ${m.model}`));
  if (m.auto) bits.push(h('span', { title: `${m.auto.via === 'model' ? 'Decided by the local check model' : m.auto.via === 'rule' ? 'Decided by a rule' : 'Check failed; used the fallback'}: ${m.auto.reason}` }, `auto → ${m.taskType}`));
  else if (m.taskType) bits.push(h('span', {}, `route ${m.taskType}`));
  if (m.ms != null) bits.push(h('span', {}, secs(m.ms)));
  const t = sum(m.attempts);
  if (t) bits.push(h('span', {}, `${n(t)} tokens`));
  meta.append(...bits);
  if (m.attempts?.length > 1) {
    meta.append(h('details', {}, h('summary', {}, `${m.attempts.length} attempts`), m.attempts.map((a) => h('span', { class: 'att' }, attemptLine(a)))));
  }
  return meta;
}
const routedLabel = (ev) => ({ chat: 'Answering', act: 'Doing it', plan: 'Planning first', approve: 'Running the approved plan' })[ev.kind] ?? `Route ${ev.route}`;
function attemptLine(a) {
  const state = a.skipped ? `skipped: ${a.skipped}` : a.ok ? `ok in ${secs(a.ms)}` : `failed in ${secs(a.ms)}: ${a.error}`;
  return `${a.connector} (${a.model}) — ${state}`;
}

function messageEl(m, index) {
  if (m.role === 'user') {
    const bubble = h('div', { class: 'bubble' }, m.text);
    if (m.shots?.length) bubble.append(h('div', { class: 'meta' }, m.shots.map((s) => h('img', { class: 'shot', src: s, alt: 'attachment' }))));
    return h('div', { class: 'm user' }, bubble,
      h('div', { class: 'acts' },
        h('button', { class: 'ghost', onclick: () => copyText(m.text) }, 'Copy'),
        h('button', { class: 'ghost', onclick: () => { $('#prompt').value = m.text; autosize(); $('#prompt').focus(); } }, 'Edit as new')));
  }
  const body = m.error ? h('div', { class:'recovery-card', role:'status' }, h('strong', {}, m.cancelled || /^(Stopped|Cancelled)$/.test(m.error) ? 'Request stopped' : 'Let’s get this moving again'), h('p', {}, m.error), m.recovery?.resetAt ? h('p', { class:'muted' }, `Budget resets ${new Date(m.recovery.resetAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}.`) : null) : markdown(m.text);
  const prior = msgs.slice(0, index).reverse().find((x) => x.role === 'user');
  // Only the newest plan can be approved (mirrors the server: failed approval runs after it don't count).
  const pendingPlan = m.plan && !m.error && index === pendingPlanIndex();
  const wrap = h('div', { class: `m bot${m.error ? ' error' : ''}${m.plan ? ' plan' : ''}` },
    h('div', { class: 'bubble' }, m.plan ? h('div', { class: 'plan-tag' }, `Plan${m.project ? ` · ${m.project}` : ''} — nothing has been changed yet`) : null, body, m.text && m.error ? markdown(m.text) : null,
      m.files?.length ? h('div', { class:'inline-media' }, m.files.map(mediaView)) : null,
      m.error && m.attempts?.length ? h('details', { class:'attempt-details' }, h('summary', {}, 'Attempt details'), m.attempts.map(a => h('p', {}, `${a.connector}: ${a.skipped || a.error || 'Completed'}`))) : null),
    ui.showMeta ? botMeta(m) : null,
    pendingPlan ? h('div', { class: 'plan-acts' },
      h('button', { class: 'primary', onclick: () => approvePlan() }, 'Approve & run'),
      h('span', { class: 'muted' }, 'or reply below to change the plan. Text in the box is sent as extra instructions when you approve.')) : null,
    h('div', { class: 'acts' },
      m.text ? h('button', { class: 'ghost', onclick: () => copyText(m.text) }, 'Copy') : null,
      prior ? h('button', { class: 'ghost', onclick: () => (prior.approved ? approvePlan() : send(m.error ? 'Please resume the interrupted task. Check current state and continue from the saved request and activity.' : prior.text)) }, m.error ? 'Resume task' : 'Retry') : null));
  return wrap;
}
function pendingPlanIndex() {
  let i = msgs.length - 1;
  while (i >= 2 && msgs[i].role === 'assistant' && msgs[i].error && msgs[i - 1].approved) i -= 2;
  return msgs[i]?.plan ? i : -1;
}
function approvePlan() {
  if (pendingPlanIndex() < 0) return toast('There is no plan waiting for approval', 'bad');
  send($('#prompt').value, { approve: true });
}

function atBottom() {
  const t = $('#thread');
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
}
function scrollDown(force) {
  const t = $('#thread');
  if (force || atBottom()) t.scrollTop = t.scrollHeight;
}
$('#thread').addEventListener('scroll', () => ($('#jump-bottom').hidden = atBottom()));
$('#jump-bottom').addEventListener('click', () => scrollDown(true));

function renderThread() {
  const thread = $('#thread');
  thread.replaceChildren();
  if (!msgs.length) {
    thread.append(h('div', { class: 'welcome' },
      h('h2', {}, 'What can I help with?'),
      h('p', { class: 'muted' }, 'The route decides which model answers. Pin a model below to override it.'),
      h('div', { class: 'suggest' }, SUGGESTIONS.map(([t, p, d, r]) => h('button', { type: 'button', onclick: () => { if (r && config?.routes[r]) setRoute(r); $('#prompt').value = p; autosize(); $('#prompt').focus(); } }, h('strong', {}, t), h('span', {}, d))))));
    return;
  }
  msgs.forEach((m, i) => thread.append(messageEl(m, i)));
  scrollDown(true);
}

function groupLabel(ts) {
  const d = new Date(ts);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 8 ? 'Previous 7 days' : 'Older';
}
function renderConversations() {
  const q = $('#conv-search').value.trim().toLowerCase();
  const list = convs.filter((c) => !q || c.title.toLowerCase().includes(q));
  const el = $('#conv-list');
  el.replaceChildren();
  if (!list.length) return el.append(h('p', { class: 'muted', style: 'padding:10px' }, q ? 'No matches.' : 'No conversations yet.'));
  const sections = new Map();
  for (const c of list) {
    const g = pins.has(c.id) ? 'Pinned' : groupLabel(c.updated);
    if (!sections.has(g)) sections.set(g, []);
    sections.get(g).push(c);
  }
  const order = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older'];
  for (const g of order) {
    if (!sections.has(g)) continue;
    el.append(h('div', { class: 'conv-group' }, g));
    for (const c of sections.get(g)) {
      el.append(h('div', { class: `conv${c.id === convId ? ' active' : ''}`, role: 'listitem', tabindex: '0', title: `${c.title}\n${when(c.updated)} · ${c.count} messages`,
        onclick: () => { show('chat'); openConversation(c.id); }, onkeydown: (e) => e.key === 'Enter' && (show('chat'), openConversation(c.id)) },
      pins.has(c.id) ? h('span', { class: 'pin' }, '●') : null, h('span', { class: 't' }, c.title),
      h('span', { class: 'ca' },
        h('button', { type: 'button', title: 'Archive', 'aria-label': `Archive ${c.title}`, onclick: (e) => { e.stopPropagation(); archiveConv(c.id, c.title); } }, icon('archive')),
        h('button', { type: 'button', class: 'del', title: 'Delete (moves to trash, can be restored)', 'aria-label': `Delete ${c.title}`, onclick: (e) => { e.stopPropagation(); trashConv(c.id, c.title); } }, icon('trash')))));
    }
  }
}
$('#conv-search').addEventListener('input', renderConversations);

async function loadConversations() {
  ({ conversations: convs } = await api('/api/conversations'));
  renderConversations();
}

function setHead(title) {
  $('#conv-title').textContent = title;
  const has = !!convId;
  for (const id of ['#rename-chat', '#archive-chat', '#delete-chat', '#export-chat', '#pin-chat']) $(id).hidden = !has;
  $('#pin-chat').textContent = pins.has(convId) ? 'Unpin' : 'Pin';
  const c = convs.find((x) => x.id === convId);
  $('#conv-meta').textContent = c ? `${c.count} messages` : '';
}

const draftKey = () => `homeai-draft:${convId ?? 'new'}`;
async function openConversation(id) {
  if (sending) return toast('Wait for the current reply or press Stop', 'bad');
  sessionStorage.setItem(draftKey(), $('#prompt').value);
  convId = id;
  if (id) localStorage.setItem('homeai-last-conversation', id); else localStorage.removeItem('homeai-last-conversation');
  msgs = [];
  if (id) {
    const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (conv.taskType && routeExists(conv.taskType)) { $('#route').value = conv.taskType; syncProjectPicker(); }
    msgs = conv.messages.map((m) => ({ ...m }));
    setHead(conv.title);
    if (conv.run?.status === 'running') {
      // Refresh/reopen observes the detached run instead of starting another one.
      const started = conv.run.started;
      const poll = async () => {
        if (convId !== id) return;
        const saved = await api(`/api/conversations/${encodeURIComponent(id)}`).catch(() => null);
        // A restart can make several polls fail. Keep observing the same saved run.
        if (!saved) return setTimeout(poll, 3000);
        if (convId !== id) return;
        if (saved.run?.status === 'running' && saved.run.started === started) return setTimeout(poll, 3000);
        msgs = saved.messages.map(m => ({...m})); renderThread(); loadConversations();
      };
      setTimeout(poll, 3000);
      toast('Your saved request is still running. Its reply will appear here.');
    }
  } else {
    setHead('New chat');
    if (config) { $('#route').value = startRoute(); syncProjectPicker(); }
  }
  renderThread();
  $('#prompt').value = sessionStorage.getItem(draftKey()) ?? '';
  autosize();
  await loadConversations();
  setHead($('#conv-title').textContent);
  $('#prompt').focus();
}
$('#new-chat').addEventListener('click', () => { show('chat'); openConversation(null); });
$('#rename-chat').addEventListener('click', async () => {
  const title = await ask('Rename conversation', '', $('#conv-title').textContent);
  if (!title?.trim()) return;
  await api(`/api/conversations/${encodeURIComponent(convId)}`, { method: 'PATCH', body: { title } });
  setHead(title.trim());
  loadConversations();
});
$('#archive-chat').addEventListener('click', () => archiveConv(convId, $('#conv-title').textContent));
$('#delete-chat').addEventListener('click', () => trashConv(convId, $('#conv-title').textContent));
$('#pin-chat').addEventListener('click', () => {
  if (pins.has(convId)) pins.delete(convId); else pins.add(convId);
  savePins();
  setHead($('#conv-title').textContent);
  renderConversations();
});
$('#export-chat').addEventListener('click', () => {
  const title = $('#conv-title').textContent;
  const md = [`# ${title}`, '', ...msgs.map((m) => (m.role === 'user' ? `**You:**\n\n${m.text}\n` : `**${m.connector ?? 'Assistant'}:**\n\n${m.text ?? `(error: ${m.error})`}\n`))].join('\n');
  download(`${title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'chat'}.md`, md);
});

// ---- Archive / delete / restore (delete = trash folder, always restorable) ----
const refreshChatLists = async () => { await loadConversations(); if (current === 'chats') await loadChats(); };
async function afterRemoved(id) {
  pins.delete(id);
  savePins();
  if (id === convId && !sending) await openConversation(null);
  await refreshChatLists();
}
async function restoreConv(id, { open = false } = {}) {
  await api(`/api/conversations/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} });
  await refreshChatLists();
  if (open) { show('chat'); await openConversation(id); }
}
async function archiveConv(id, title = 'Chat') {
  try {
    await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await afterRemoved(id);
    toast(`Archived "${title}"`, 'ok', { label: 'Undo', run: () => restoreConv(id).catch((e) => toast(e.message, 'bad')) });
  } catch (err) { toast(err.message, 'bad'); }
}
async function trashConv(id, title = 'Chat') {
  try {
    await api(`/api/conversations/${encodeURIComponent(id)}/trash`, { method: 'POST', body: {} });
    await afterRemoved(id);
    toast(`Deleted "${title}" (kept in trash)`, 'ok', { label: 'Undo', run: () => restoreConv(id).catch((e) => toast(e.message, 'bad')) });
  } catch (err) { toast(err.message, 'bad'); }
}
async function renameConv(id, title) {
  const next = await ask('Rename conversation', '', title);
  if (!next?.trim()) return;
  await api(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title: next } });
  if (id === convId) setHead(next.trim());
  await refreshChatLists();
}

// ---- Chats manager (the Chat nav item) ----
const chatsUi = { state: 'active', route: '', sort: 'recent', q: '', selected: new Set(), lists: { active: [], archived: [], trash: [] } };
const STATE_LABEL = { active: 'Active', archived: 'Archived', trash: 'Trash' };
function visibleChats() {
  const q = chatsUi.q.trim().toLowerCase();
  const list = chatsUi.lists[chatsUi.state].filter((c) => (!chatsUi.route || c.taskType === chatsUi.route) && (!q || `${c.title} ${c.preview ?? ''}`.toLowerCase().includes(q)));
  const by = { recent: (a, b) => b.updated - a.updated, oldest: (a, b) => a.updated - b.updated, title: (a, b) => a.title.localeCompare(b.title), size: (a, b) => b.count - a.count };
  return list.sort(by[chatsUi.sort]);
}
async function loadChats() {
  const [active, archived, trash] = await Promise.all(['active', 'archived', 'trash'].map((st) => api(`/api/conversations?state=${st}`).then((r) => r.conversations)));
  chatsUi.lists = { active, archived, trash };
  convs = active;
  const ids = new Set(chatsUi.lists[chatsUi.state].map((c) => c.id));
  for (const id of chatsUi.selected) if (!ids.has(id)) chatsUi.selected.delete(id);
  const routes = [...new Set(Object.values(chatsUi.lists).flat().map((c) => c.taskType).filter(Boolean))].sort();
  const sel = $('#chats-route');
  sel.replaceChildren(h('option', { value: '' }, 'All'), ...routes.map((r) => h('option', { value: r }, r)));
  sel.value = routes.includes(chatsUi.route) ? chatsUi.route : '';
  chatsUi.route = sel.value;
  renderChats();
  renderConversations();
}
function renderChats() {
  const st = chatsUi.state;
  $('#chats-state').replaceChildren(...Object.keys(STATE_LABEL).map((k) => h('button', { type: 'button', class: st === k ? 'on' : '', onclick: () => { chatsUi.state = k; chatsUi.selected.clear(); renderChats(); } }, STATE_LABEL[k], h('span', { class: 'cnt' }, String(chatsUi.lists[k].length)))));
  const rows = visibleChats();
  const allOn = rows.length && rows.every((c) => chatsUi.selected.has(c.id));
  const bulk = $('#chats-bulk');
  const count = chatsUi.selected.size;
  bulk.hidden = !count;
  if (count) {
    const each = async (path, method, done) => {
      try {
        for (const id of [...chatsUi.selected]) await api(path(id), { method, body: method === 'POST' ? {} : undefined });
        toast(done, 'ok');
      } catch (e) { toast(e.message, 'bad'); }
      chatsUi.selected.clear();
      await refreshChatLists();
    };
    const base = (id) => `/api/conversations/${encodeURIComponent(id)}`;
    bulk.replaceChildren(h('b', {}, `${count} selected`), h('span', { class: 'spacer' }),
      st !== 'active' ? h('button', { class: 'sm', onclick: () => each((id) => `${base(id)}/restore`, 'POST', `Restored ${count}`) }, 'Restore') : null,
      st === 'active' ? h('button', { class: 'sm', onclick: () => each(base, 'DELETE', `Archived ${count}`) }, 'Archive') : null,
      st !== 'trash' ? h('button', { class: 'sm danger', onclick: () => { if (confirm(`Delete ${count} chat${count > 1 ? 's' : ''}? They move to the trash and can be restored from there.`)) each((id) => `${base(id)}/trash`, 'POST', `Deleted ${count} (kept in trash)`); } }, 'Delete') : null,
      h('button', { class: 'ghost sm', onclick: () => { chatsUi.selected.clear(); renderChats(); } }, 'Clear'));
  }
  $('#chats-note').textContent = st === 'trash' ? 'Deleted chats stay in data/conversations/trash until you remove them by hand. Restore brings one back.' : st === 'archived' ? 'Archived chats are kept in data/conversations/archive. Opening one restores it.' : '';
  const table = $('#chats-table');
  if (!rows.length) {
    table.replaceChildren(h('div', { class: 'panel muted' }, chatsUi.q || chatsUi.route ? 'No chats match.' : st === 'active' ? 'No conversations yet. Start one with New chat.' : `Nothing in ${STATE_LABEL[st].toLowerCase()}.`));
    return;
  }
  const open = (c) => { if (st === 'active') { show('chat'); openConversation(c.id); } else restoreConv(c.id, { open: true }).catch((e) => toast(e.message, 'bad')); };
  const act = (label, fn, cls = 'ghost sm') => h('button', { type: 'button', class: cls, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
  table.replaceChildren(h('table', { class: 'chat-table' },
    h('thead', {}, h('tr', {},
      h('th', { class: 'sel' }, h('input', { type: 'checkbox', checked: allOn ? true : null, 'aria-label': 'Select all', onchange: (e) => { for (const c of rows) { if (e.target.checked) chatsUi.selected.add(c.id); else chatsUi.selected.delete(c.id); } renderChats(); } })),
      h('th', {}, 'Chat'), h('th', {}, 'Route'), h('th', { class: 'num' }, 'Msgs'), h('th', {}, 'Updated'), h('th', {}, ''))),
    h('tbody', {}, rows.map((c) => h('tr', { class: 'row' },
      h('td', { class: 'sel' }, h('input', { type: 'checkbox', checked: chatsUi.selected.has(c.id) ? true : null, 'aria-label': `Select ${c.title}`, onchange: (e) => { if (e.target.checked) chatsUi.selected.add(c.id); else chatsUi.selected.delete(c.id); renderChats(); } })),
      h('td', {}, h('div', { class: 'title', tabindex: '0', role: 'link', title: st === 'active' ? 'Open this chat' : 'Restore and open this chat', onclick: () => open(c), onkeydown: (e) => e.key === 'Enter' && open(c) }, (pins.has(c.id) ? '● ' : '') + c.title), c.preview ? h('div', { class: 'prev' }, c.preview) : null),
      h('td', {}, c.taskType ? h('span', { class: 'pill' }, c.taskType) : '', c.project ? h('span', { class: 'muted' }, ` ${c.project}`) : ''),
      h('td', { class: 'num' }, String(c.count)),
      h('td', { class: 'muted' }, when(c.updated)),
      h('td', {}, h('div', { class: 'rowacts' },
        st === 'active' ? act('Open', () => open(c)) : act('Restore', () => restoreConv(c.id).then(() => toast('Restored', 'ok')).catch((e) => toast(e.message, 'bad'))),
        st === 'active' ? act('Rename', () => renameConv(c.id, c.title).catch((e) => toast(e.message, 'bad'))) : null,
        st === 'active' ? act('Archive', () => archiveConv(c.id, c.title)) : null,
        st !== 'trash' ? act('Delete', () => trashConv(c.id, c.title), 'ghost sm danger') : null)))))));
}
$('#chats-search').addEventListener('input', (e) => { chatsUi.q = e.target.value; renderChats(); });
$('#chats-route').addEventListener('change', (e) => { chatsUi.route = e.target.value; renderChats(); });
$('#chats-sort').addEventListener('change', (e) => { chatsUi.sort = e.target.value; renderChats(); });
$('#chats-new').addEventListener('click', () => { show('chat'); openConversation(null); });
loaders.chats = loadChats;

// ---- Image attachments ----
let pending = [];
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
function renderAttachments() {
  const strip = $('#attach-strip');
  strip.hidden = !pending.length;
  strip.replaceChildren(...pending.map((p, i) => h('span', { class: 'thumb' }, h('img', { src: p.url, alt: p.name }), h('button', { type: 'button', title: 'Remove', onclick: () => { URL.revokeObjectURL(p.url); pending.splice(i, 1); renderAttachments(); } }, '×'))));
}
async function addFiles(files) {
  for (const f of files) {
    if (!IMG_TYPES.includes(f.type)) { toast(`${f.name}: not an image type I can send`, 'bad'); continue; }
    if (pending.length >= 4) { toast('At most 4 images per message', 'bad'); break; }
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(f);
    });
    pending.push({ name: f.name || 'pasted-image', mediaType: f.type, data, url: URL.createObjectURL(f) });
  }
  renderAttachments();
}
$('#attach').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', async (e) => { await addFiles([...e.target.files]); e.target.value = ''; });
$('#prompt').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$('#composer').addEventListener('dragover', (e) => { e.preventDefault(); $('#composer').classList.add('drag'); });
$('#composer').addEventListener('dragleave', () => $('#composer').classList.remove('drag'));
$('#composer').addEventListener('drop', (e) => { e.preventDefault(); $('#composer').classList.remove('drag'); addFiles([...e.dataTransfer.files]); });

// ---- Composer: autosize, history, slash commands ----
function autosize() {
  const p = $('#prompt');
  p.style.height = 'auto';
  p.style.height = `${Math.min(p.scrollHeight, window.innerHeight * 0.4)}px`;
  $('#count').textContent = p.value.length > 400 ? `~${n(Math.ceil(p.value.length / 4))} tokens` : '';
}
const promptHistory = JSON.parse(localStorage.getItem('homeai-prompts') || '[]');
let histIdx = -1;
const remember = (t) => {
  if (promptHistory[0] !== t) promptHistory.unshift(t);
  promptHistory.length = Math.min(promptHistory.length, 50);
  localStorage.setItem('homeai-prompts', JSON.stringify(promptHistory));
  histIdx = -1;
};

const SLASH = [
  { cmd: '/new', desc: 'Start a new conversation', run: () => openConversation(null) },
  { cmd: '/route', desc: 'Switch route: /route <name>', arg: true, run: (a) => setRoute(a) },
  { cmd: '/plan', desc: 'Plan a change in a project, then approve it: /plan <what to change>', arg: true, run: (a) => { if (!config?.routes.plan) return toast('There is no "plan" route in config/routes.json', 'bad'); setRoute('plan'); if (a) send(a); } },
  { cmd: '/job', desc: 'Queue a background job and keep chatting: /job <what to do>', arg: true, run: (a) => queueFromChat(a) },
  { cmd: '/model', desc: 'Pin a model: /model <name|auto>', arg: true, run: (a) => setModel(a) },
  { cmd: '/export', desc: 'Download this chat as Markdown', run: () => $('#export-chat').click() },
  { cmd: '/theme', desc: 'Cycle light / dark / system', run: () => cycleTheme() },
  { cmd: '/go', desc: 'Open a page: /go usage', arg: true, run: (a) => show(a) },
];
function setRoute(name) {
  if (!routeExists(name)) return toast(`Unknown route "${name}". Routes: ${[...(config?.auto ? ['auto'] : []), ...Object.keys(config?.routes ?? {})].join(', ')}`, 'bad');
  $('#route').value = name;
  syncProjectPicker();
  toast(`Route: ${name}`, 'ok');
}
function setModel(name) {
  if (!name || name === 'auto') { $('#pin').value = ''; return toast('Model: auto', 'ok'); }
  if (!config?.connectors[name]) return toast(`Unknown model "${name}"`, 'bad');
  $('#pin').value = name;
  toast(`Pinned ${name}`, 'ok');
}
let slashIdx = 0;
function slashMatches() {
  const v = $('#prompt').value;
  if (!/^\/\w*$/.test(v)) return [];
  return SLASH.filter((s) => s.cmd.startsWith(v.toLowerCase()));
}
function renderSlash() {
  const items = slashMatches();
  const menu = $('#slash-menu');
  menu.hidden = !items.length;
  slashIdx = Math.min(slashIdx, Math.max(items.length - 1, 0));
  menu.replaceChildren(...items.map((s, i) => h('div', { class: `slash-item${i === slashIdx ? ' on' : ''}`, onmousedown: (e) => { e.preventDefault(); pickSlash(s); } }, h('b', {}, s.cmd), h('span', {}, s.desc))));
}
function pickSlash(s) {
  if (s.arg) { $('#prompt').value = `${s.cmd} `; autosize(); renderSlash(); }
  else { $('#prompt').value = ''; autosize(); renderSlash(); s.run(); }
}
$('#prompt').addEventListener('input', () => {
  autosize();
  slashIdx = 0;
  renderSlash();
  sessionStorage.setItem(draftKey(), $('#prompt').value);
});
$('#prompt').addEventListener('keydown', (e) => {
  const items = slashMatches();
  if (items.length) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % items.length; return renderSlash(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + items.length) % items.length; return renderSlash(); }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); return pickSlash(items[slashIdx]); }
    if (e.key === 'Escape') { $('#slash-menu').hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (ui.enterSends || e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $('#composer').requestSubmit();
  } else if (e.key === 'ArrowUp' && !e.target.value.trim() && promptHistory.length) {
    e.preventDefault();
    histIdx = Math.min(histIdx + 1, promptHistory.length - 1);
    e.target.value = promptHistory[histIdx];
    autosize();
  } else if (e.key === 'ArrowDown' && histIdx >= 0) {
    e.preventDefault();
    histIdx -= 1;
    e.target.value = histIdx >= 0 ? promptHistory[histIdx] : '';
    autosize();
  }
});

// ---- Streaming send ----
let chatAbort = null;
let activeRunId = null;
// Stop asks the service to cancel the run (the server keeps running a chat when the connection drops, so Stop must be explicit).
$('#stop').addEventListener('click', () => {
  if (activeRunId) api(`/api/runs/${encodeURIComponent(activeRunId)}/cancel`, { method: 'POST', body: {} }).catch(() => {});
  chatAbort?.abort();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits for the service to save the reply after the connection dropped. Resolves with the conversation, or null after the limit.
async function awaitSavedReply(id, since, status) {
  const deadline = Date.now() + 35 * 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const conv = await api(`/api/conversations/${encodeURIComponent(id)}`).catch(() => null);
    const last = conv?.messages?.at(-1);
    if (last?.role === 'assistant' && last.ts >= since) return conv;
    status.textContent = 'Connection to the service dropped. Still waiting for the reply to be saved…';
  }
  return null;
}

// approve: run the pending plan; text (optional) is sent as extra instructions.
async function send(text, { approve = false } = {}) {
  if (sending || (!approve && !text.trim())) return;
  text = text.trim();
  if (approve && pending.length) return toast('Remove the attached images before approving a plan', 'bad');
  const slash = !approve && /^\/(\w+)\s*(.*)$/.exec(text);
  if (slash) {
    const s = SLASH.find((x) => x.cmd === `/${slash[1].toLowerCase()}`);
    if (s) { $('#prompt').value = ''; autosize(); return s.run(slash[2].trim()); }
  }
  sending = true;
  if (text) remember(text);
  $('#send').disabled = true;
  $('#stop').hidden = false;
  const images = pending.map(({ name, mediaType, data }) => ({ name, mediaType, data }));
  const shots = pending.map((p) => p.url);
  $('#prompt').value = '';
  sessionStorage.removeItem(draftKey());
  autosize();
  const userMsg = approve
    ? { role: 'user', text: text ? `Approved — run the plan.\n${text}` : 'Approved — run the plan.', approved: true }
    : { role: 'user', text: images.length ? `${text}\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : text, shots };
  msgs.push(userMsg);
  const thread = $('#thread');
  thread.querySelector('.welcome')?.remove();
  thread.querySelector('.plan-acts')?.remove();
  thread.append(messageEl(userMsg, msgs.length - 1));

  // Live bubble: deltas stream in as markdown; tool use and fallbacks appear as status lines.
  const toolList = h('div', { class:'tools' });
  const toolSummary = h('summary', {}, 'Activity');
  const tools = h('details', { class:'tool-activity', hidden:true }, toolSummary, toolList);
  const body = h('div', {}, h('span', { class: 'typing' }, h('i'), h('i'), h('i')));
  const status = h('div', { class: 'meta' }, 'Starting…');
  const live = h('div', { class: 'm bot live' }, h('div', { class: 'bubble' }, tools, body), status);
  thread.append(live);
  scrollDown(true);
  let acc = '';
  let raf = 0;
  const paint = () => { raf = 0; const keep = atBottom(); body.replaceChildren(markdown(acc)); if (keep) scrollDown(true); };
  const started = Date.now();
  const tick = setInterval(() => ($('#busy').textContent = secs(Date.now() - started)), 250);
  chatAbort = new AbortController();
  const runId = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
  activeRunId = runId;
  const wasNew = !convId;
  const sentAt = Date.now();
  let reached = false; // true once the service has answered; before that a failure means nothing was saved
  try {
    const req = approve
      ? { conversationId: convId, approve: true, prompt: text || undefined, connector: $('#pin').value || undefined, runId }
      : {
          conversationId: convId ?? undefined, prompt: text, taskType: $('#route').value, connector: $('#pin').value || undefined, runId,
          images: images.length ? images : undefined, project: $('#project-label').hidden ? undefined : $('#project').value || undefined,
        };
    const r = await stream('/api/chat', req, (ev) => {
      reached = true;
      if (ev.type === 'conversation') { convId = ev.id; localStorage.setItem('homeai-last-conversation', convId); }
      else if (ev.type === 'routing') status.textContent = 'Checking what this needs…';
      else if (ev.type === 'routed') status.textContent = `${routedLabel(ev)} · ${ev.reason}…`;
      else if (ev.type === 'attempt') { acc = ''; toolList.replaceChildren(); tools.hidden=true; status.textContent = `${ev.connector} · ${ev.model}…`; paint(); }
      else if (ev.type === 'delta') { acc += ev.text; if (!raf) raf = requestAnimationFrame(paint); }
      else if (ev.type === 'tool') { tools.hidden=false; toolList.append(h('div', { class: 'tool' }, `${ev.name}${ev.summary ? `: ${ev.summary}` : ''}`)); toolSummary.textContent=`Activity · ${toolList.children.length} steps`; scrollDown(); }
      else if (ev.type === 'attempt-skipped') status.textContent = `${ev.connector} unavailable within current limits; checking alternatives…`;
      else if (ev.type === 'attempt-failed') status.textContent = `${ev.connector} failed (${ev.error}); trying next…`;
    }, chatAbort.signal);
    live.remove();
    convId = r.conversation.id;
    msgs.push({ role: 'assistant', ...r.reply });
    thread.append(messageEl(msgs.at(-1), msgs.length - 1));
    scrollDown(true);
    pending = [];
    renderAttachments();
    await loadConversations();
    setHead(wasNew ? r.conversation.title : $('#conv-title').textContent);
  } catch (err) {
    const stopped = err.name === 'AbortError';
    const dropped = !stopped && reached && (err.name === 'TypeError' || /Stream ended without a result/.test(err.message));
    if (dropped) {
      // The service keeps the run going and saves the reply. Wait for it instead of showing an error or re-sending.
      let saved = null;
      if (convId) {
        status.textContent = 'Connection to the service dropped. Waiting for the reply to be saved…';
        saved = await awaitSavedReply(convId, sentAt, status).catch(() => null);
      }
      live.remove();
      if (saved) {
        msgs = saved.messages.map((m) => ({ ...m }));
        renderThread();
        setHead(saved.title);
        await loadConversations();
      } else {
        const m = { role: 'assistant', error: convId ? 'Lost the connection to the service and no reply was saved within 35 minutes. Open this chat from the list to check.' : 'Lost the connection to the service before the chat was created. Check the chat list.' };
        msgs.push(m);
        thread.append(messageEl(m, msgs.length - 1));
        scrollDown(true);
      }
      await loadConversations().catch(() => {});
    } else {
      live.remove();
      const m = { role: 'assistant', error: stopped ? 'Stopped' : (reached ? err.message : `Could not reach the service: ${err.message}`), ...(acc ? { text: acc } : {}) };
      msgs.push(m);
      thread.append(messageEl(m, msgs.length - 1));
      scrollDown(true);
      // Put the prompt back so it can be resent (a dropped connection never reaches this branch, so nothing is sent twice).
      if (!stopped) $('#prompt').value = text;
      autosize();
    }
  } finally {
    activeRunId = null;
    cancelAnimationFrame(raf);
    clearInterval(tick);
    chatAbort = null;
    $('#busy').textContent = '';
    $('#send').disabled = false;
    $('#stop').hidden = true;
    sending = false;
    $('#prompt').focus();
  }
}
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); send($('#prompt').value); });

function syncProjectPicker() {
  syncModels();
  const r = $('#route').value;
  const agent = r === 'auto' ? !!config?.auto && canAct() : !!config?.routes[r]?.agent;
  $('#project-label').hidden = !agent || !config?.features.shell;
}
$('#route').addEventListener('change', syncProjectPicker);

let projects = [];
async function loadProjects() {
  if (!config?.features.shell) return;
  const r = await api('/api/projects').catch(() => null);
  if (!r) return;
  projects = r.projects;
  const opts = () => projects.map((p) => h('option', { value: p.name }, p.name === r.default ? `${p.name} (default)` : p.name));
  const el = $('#project');
  const prev = el.value;
  el.replaceChildren(...opts());
  el.value = prev && projects.some((p) => p.name === prev) ? prev : r.default;
  $('#term-paths').replaceChildren(...projects.map((p) => h('option', { value: p.path }, p.name)));
}

loaders.chat = async () => {
  await loadConfig();
  applyFeatures();
  await Promise.all([loadConversations(), loadProjects()]);
  syncProjectPicker();
  if (!msgs.length) renderThread();
  setHead($('#conv-title').textContent);
  $('#prompt').focus();
};

// ---- Overview ----
async function statusCard(k, v, d, cls = '') {
  return h('div', { class: `card ${cls}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), d ? h('div', { class: 'd' }, d) : null);
}
function capList(u) {
  return h('p', { class: 'muted' }, 'Usage counters are informational. Model access is never blocked by local counters. Clear usage resets counters without deleting history.');
}
loaders.overview = async () => {
  const [u, s, hist] = await Promise.all([api('/api/usage?hours=24'), api('/api/status').catch(() => null), api('/api/history?limit=8').catch(() => ({ tasks: [] }))]);
  const t = u.total;
  const conns = s ? Object.values(s.connectors) : [];
  const ready = conns.filter((c) => c.ok).length;
  $('#ov-cards').replaceChildren(
    await statusCard('Calls · 24h', n(t.calls), `${n(u.byConnector ? Object.keys(u.byConnector).length : 0)} models used`),
    await statusCard('Tokens · 24h', n(t.inputTokens + t.outputTokens), `${n(t.inputTokens)} in · ${n(t.outputTokens)} out`),
    await statusCard('API-equivalent cost', `$${t.costUsd.toFixed(2)}`, 'reported, not billed'),
    await statusCard('Models ready', s ? `${ready}/${conns.length}` : '—', s ? 'from last status check' : 'status unavailable', s ? (ready === conns.length ? 'ok' : 'bad') : ''),
  );
  $('#ov-backends').replaceChildren(s
    ? h('div', { class: 'share' }, Object.entries(s.backends).map(([k, b]) => h('div', { class: 'row' }, h('span', { class: `pill ${b.ok ? 'ok' : 'bad'}` }, b.ok ? 'up' : 'down'), h('strong', {}, k), h('span', { class: 'muted' }, b.detail ?? ''))))
    : h('p', { class: 'muted' }, 'Status checks are not enabled.'));
  $('#ov-caps').replaceChildren(capList(u));
  $('#ov-recent').replaceChildren(hist.tasks.length
    ? h('table', {}, hist.tasks.map((x) => h('tr', { class: 'click', onclick: () => show('history') },
      h('td', { class: 'muted' }, when(x.ts)), h('td', {}, x.taskType), h('td', {}, x.connector ?? '—'),
      h('td', {}, h('span', { class: `pill ${x.ok ? 'ok' : 'bad'}` }, x.ok ? 'ok' : 'failed')), h('td', { class: 'num muted' }, secs(x.ms)))))
    : h('p', { class: 'muted' }, 'No tasks yet.'));
  const acts = [
    ['New chat', 'plus', () => { show('chat'); openConversation(null); }],
    ['Check status', 'pulse', () => { show('status'); }],
    ['Open usage', 'chart', () => show('usage')],
    ['Edit routes', 'cog', () => show('config')],
    ['Settings', 'sliders', () => show('settings')],
  ];
  $('#ov-actions').replaceChildren(...acts.map(([l, i, f]) => h('button', { onclick: f }, icon(i), l)));
};
$('#ov-refresh').addEventListener('click', () => api('/api/status?fresh=1').then(() => loaders.overview()).catch((e) => toast(e.message, 'bad')));

// ---- Usage ----
function shareList(rows, nameLabel) {
  const entries = Object.entries(rows).sort((a, b) => (b[1].inputTokens + b[1].outputTokens) - (a[1].inputTokens + a[1].outputTokens));
  if (!entries.length) return h('p', { class: 'muted' }, 'No calls in this window.');
  const max = Math.max(...entries.map(([, t]) => t.inputTokens + t.outputTokens), 1);
  return h('div', { class: 'share', 'aria-label': nameLabel }, entries.map(([k, t]) => {
    const tok = t.inputTokens + t.outputTokens;
    return h('div', { class: 'share-row', title: `${n(t.inputTokens)} in · ${n(t.outputTokens)} out${t.costUsd ? ` · $${t.costUsd.toFixed(4)}` : ''}` },
      h('span', { class: 'nm' }, k), h('div', { class: 'bar acc' }, h('span', { style: `width:${(100 * tok) / max}%` })), h('span', { class: 'val' }, `${n(tok)} · ${n(t.calls)}×`));
  }));
}
loaders.usage = async () => {
  const u = await api(`/api/usage?hours=${$('#usage-hours').value}`);
  const t = u.total;
  $('#usage-totals').replaceChildren(
    ...[['Calls', n(t.calls)], ['Tokens in', n(t.inputTokens)], ['Tokens out', n(t.outputTokens)], ['Reported cost (API-equivalent)', `$${t.costUsd.toFixed(4)}`]]
      .map(([k, v]) => h('div', { class: 'card' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v))));
  $('#usage-caps').replaceChildren(capList(u));
  $('#usage-conn').replaceChildren(shareList(u.byConnector, 'By model'));
  $('#usage-route').replaceChildren(shareList(u.byTaskType, 'By route'));
};
$('#usage-hours').addEventListener('change', () => loaders.usage());
$('#usage-refresh').addEventListener('click', () => loaders.usage());

$('#usage-clear').addEventListener('click', async () => {
  const button = $('#usage-clear');
  button.disabled = true;
  try {
    await api('/api/usage/reset', { method: 'POST' });
    await loaders.usage();
    toast('Usage cleared. Chat history preserved.');
  } catch (e) { toast(e.message, 'bad'); }
  finally { button.disabled = false; }
});

// ---- History ----
let historyCache = [];
function renderHistory() {
  const q = $('#history-search').value.trim().toLowerCase();
  const want = $('#history-result').value;
  const rows = historyCache.filter((t) => {
    const fellBack = (t.attempts?.length ?? 0) > 1;
    if (want === 'ok' && !(t.ok && !fellBack)) return false;
    if (want === 'fallback' && !(t.ok && fellBack)) return false;
    if (want === 'failed' && t.ok) return false;
    return !q || [t.prompt, t.taskType, t.connector, t.source].some((x) => String(x ?? '').toLowerCase().includes(q));
  });
  $('#history-count').textContent = `${rows.length} of ${historyCache.length}`;
  if (!rows.length) return $('#history').replaceChildren(h('p', { class: 'muted' }, 'No matching tasks.'));
  const table = h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Source', 'Route', 'Answered by', 'Result'].map((x) => h('th', {}, x)), h('th', { class: 'num' }, 'Time'), h('th', { class: 'num' }, 'Tokens'))));
  const bodyEl = h('tbody');
  for (const t of rows) {
    const fellBack = (t.attempts?.length ?? 0) > 1;
    const row = h('tr', { class: 'click' },
      h('td', {}, when(t.ts)), h('td', {}, t.source ?? 'api'), h('td', {}, t.taskType),
      h('td', {}, t.connector ?? '—', t.pinned ? ' (pinned)' : ''),
      h('td', {}, h('span', { class: `pill ${t.ok ? (fellBack ? 'warn' : 'ok') : 'bad'}` }, t.ok ? (fellBack ? 'ok after fallback' : 'ok') : 'failed')),
      h('td', { class: 'num' }, secs(t.ms)), h('td', { class: 'num' }, n(sum(t.attempts))));
    const detail = h('tr', { class: 'detail', hidden: true }, h('td', { colspan: 7 },
      h('strong', {}, 'Prompt'), h('div', {}, t.prompt ?? ''),
      h('strong', {}, t.ok ? 'Answer' : 'Error'), t.ok ? markdown(t.text ?? '') : h('div', {}, t.error ?? ''),
      h('strong', {}, 'Attempts'), (t.attempts ?? []).map((a) => h('div', {}, attemptLine(a)))));
    row.addEventListener('click', () => (detail.hidden = !detail.hidden));
    bodyEl.append(row, detail);
  }
  table.append(bodyEl);
  $('#history').replaceChildren(table);
}
loaders.history = async () => {
  ({ tasks: historyCache } = await api('/api/history?limit=300'));
  renderHistory();
};
$('#history-refresh').addEventListener('click', () => loaders.history());
$('#history-search').addEventListener('input', renderHistory);
$('#history-result').addEventListener('change', renderHistory);

// ---- Status ----
async function loadStatus(fresh) {
  $('#status-time').textContent = 'Checking…';
  const s = await api(`/api/status${fresh ? '?fresh=1' : ''}`);
  $('#status-time').textContent = `Checked ${new Date(s.checkedAt).toLocaleTimeString()}`;
  $('#status-backends').replaceChildren(...Object.entries(s.backends).map(([k, b]) => h('div', { class: `card ${b.ok ? 'ok' : 'bad'}` }, h('div', { class: 'k' }, k), h('div', { class: 'v', style: 'font-size:16px' }, b.ok ? 'Available' : 'Unavailable'), h('div', { class: 'd' }, b.detail ?? ''))));
  $('#status-conn').replaceChildren(h('table', {},
    h('thead', {}, h('tr', {}, ['Connector', 'Kind', 'Model', 'State', 'Detail'].map((x) => h('th', {}, x)))),
    h('tbody', {}, Object.entries(s.connectors).map(([name, c]) => h('tr', {}, h('td', {}, h('strong', {}, name)), h('td', {}, c.kind), h('td', { class: 'mono' }, c.model),
      h('td', {}, h('span', { class: `pill ${c.ok ? 'ok' : 'bad'}` }, c.ok ? (c.loaded ? 'ready (loaded)' : 'ready') : 'unavailable')),
      h('td', { class: 'muted' }, c.detail ?? (c.kind === 'ollama' && !c.loaded ? 'loads on first use' : '')))))));
}
loaders.status = () => loadStatus(false);
$('#status-refresh').addEventListener('click', () => loadStatus(true).catch((e) => ($('#status-time').textContent = e.message)));

// ---- Schedule ----
async function loadSchedule() {
  const s = await api('/api/schedule');
  $('#schedule-state').replaceChildren(h('span', { class: `pill ${s.enabled ? 'ok' : 'bad'}` }, s.enabled ? 'Scheduler on' : 'Scheduler off (jobs only run on demand)'));
  const rows = s.jobs.map((j) => {
    const r = j.lastRun;
    const btn = h('button', { class: 'ghost sm' }, j.running ? 'Running…' : 'Run now');
    btn.disabled = j.running;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Running…';
      try { await api('/api/schedule/run', { method: 'POST', body: { name: j.name } }); toast(`${j.name} finished`, 'ok'); } catch (e) { toast(e.message, 'bad'); }
      loadSchedule().catch(() => {});
    });
    return h('tr', {}, h('td', {}, h('strong', {}, j.name)), h('td', {}, j.dailyAt ? `daily at ${j.dailyAt}` : `every ${j.everyMinutes} min`),
      h('td', {}, h('span', { class: `pill ${j.enabled === false ? '' : 'ok'}` }, j.enabled === false ? 'disabled' : 'enabled')),
      h('td', {}, r ? `${when(r.ts)} ${r.ok === undefined ? '' : r.ok ? '✓' : `✗ exit ${r.code}`}` : 'never'),
      h('td', { class: 'muted' }, r?.output ?? ''), h('td', {}, btn));
  });
  $('#schedule-jobs').replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Job', 'When', 'State', 'Last run', 'Output', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No jobs configured')))));
  const q = Object.entries(s.queue ?? {});
  $('#schedule-queue').replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Backend', 'Running', 'Waiting', 'Limit'].map((t) => h('th', {}, t)))),
    h('tbody', {}, q.length ? q.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v.active), h('td', {}, v.queued), h('td', {}, v.limit))) : h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'No requests yet')))));
}
loaders.schedule = loadSchedule;

// ---- Jobs: queue work, it runs to completion unattended ----
const JOB_PILL = { queued: '', running: 'warn', done: 'ok', failed: 'bad', cancelled: '', 'needs-input': 'warn' };
let jobsTimer = null;
const jobsOpen = new Set();
async function queueFromChat(text) {
  if (!text) return toast('Usage: /job <what to do>', 'bad');
  try {
    const j = await api('/api/jobs', { method: 'POST', body: { prompt: text, project: $('#project')?.value || undefined } });
    toast(`Queued: ${j.title}. Watch it on the Jobs page.`, 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}
async function submitJobs(e) {
  e.preventDefault();
  const text = $('#job-text').value.trim();
  if (!text) return;
  const base = { project: $('#job-project').value || undefined, route: $('#job-route').value || undefined, planFirst: $('#job-plan').checked };
  // One job per blank-line-separated block when "split" is on; otherwise the whole box is one job.
  const parts = $('#job-split').checked ? text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean) : [text];
  const btn = $('#job-add');
  btn.disabled = true;
  try {
    const r = parts.length === 1 ? await api('/api/jobs', { method: 'POST', body: { ...base, prompt: parts[0] } }) : await api('/api/jobs', { method: 'POST', body: { jobs: parts.map((prompt) => ({ ...base, prompt })) } });
    const n = parts.length === 1 ? 1 : r.results.filter((x) => x.ok).length;
    $('#job-text').value = '';
    toast(`${n} job${n === 1 ? '' : 's'} queued`, 'ok');
  } catch (err) { toast(err.message, 'bad'); }
  btn.disabled = false;
  loadJobs().catch(() => {});
}
function jobDetail(j) {
  const log = (j.log ?? []).map((l) => `${new Date(l.ts).toLocaleTimeString()}  ${l.msg}`).join('\n');
  return h('div', { class: 'job-detail' },
    j.question ? h('p', {}, h('b', {}, 'Needs input: '), j.question) : null,
    j.result?.text ? h('pre', { class: 'term' }, j.result.text) : j.error ? h('pre', { class: 'term' }, j.error) : null,
    h('details', {}, h('summary', { class: 'muted' }, 'Activity log'), h('pre', { class: 'term' }, log || '(empty)')));
}
async function loadJobs() {
  const s = await api('/api/jobs');
  const sel = $('#job-project');
  if (!sel.options.length && projects.length) sel.replaceChildren(...projects.map((p) => h('option', { value: p.name }, p.name)));
  const route = $('#job-route');
  if (route.options.length < 2) route.replaceChildren(h('option', { value: '' }, 'default (agent)'), ...Object.keys(config?.routes ?? {}).map((r) => h('option', { value: r }, r)));
  const post = (path) => async () => { await api(path, { method: 'POST', body: {} }).catch((err) => toast(err.message, 'bad')); loadJobs(); };
  $('#jobs-state').replaceChildren(
    h('span', { class: `pill ${s.running ? 'warn' : 'ok'}` }, `${s.running} running · ${s.queued} waiting · up to ${s.concurrency} at once`),
    h('button', { class: 'ghost sm', onclick: post(s.paused ? '/api/jobs/resume' : '/api/jobs/pause') }, s.paused ? 'Resume queue' : 'Pause queue'),
    h('button', { class: 'ghost sm', onclick: post('/api/jobs/clear') }, 'Clear finished'));
  const act = (j, path, body = {}) => async () => { try { await api(`/api/jobs/${j.id}/${path}`, { method: 'POST', body }); } catch (err) { toast(err.message, 'bad'); } loadJobs(); };
  const rows = [];
  for (const j of s.jobs) {
    const open = jobsOpen.has(j.id);
    const buttons = [];
    if (j.status === 'queued' || j.status === 'running') buttons.push(h('button', { class: 'ghost sm', onclick: act(j, 'cancel') }, 'Cancel'));
    if (['failed', 'cancelled', 'needs-input'].includes(j.status)) {
      const ask = j.status === 'needs-input';
      buttons.push(h('button', { class: 'ghost sm', onclick: () => {
        const g = ask ? window.prompt(`${j.question}\n\nYour answer or guidance:`) : '';
        if (g === null) return;
        act(j, 'retry', { guidance: g || undefined })();
      } }, ask ? 'Answer' : 'Retry'));
    }
    const state = j.status === 'running' ? (j.activity?.text ?? 'working…') : j.status === 'queued' && j.attempts ? `retrying (attempt ${j.attempts + 1})` : (j.summary ?? j.error ?? '');
    rows.push(h('tr', { class: 'job-row', onclick: (ev) => { if (ev.target.closest('button')) return; if (open) jobsOpen.delete(j.id); else jobsOpen.add(j.id); loadJobs(); } },
      h('td', {}, h('strong', {}, j.title), h('div', { class: 'muted' }, [j.project, j.route, j.planFirst ? 'plan first' : null, j.connector].filter(Boolean).join(' · '))),
      h('td', {}, h('span', { class: `pill ${JOB_PILL[j.status] ?? ''}` }, j.status), j.continues ? h('span', { class: 'muted' }, ` +${j.continues} cont.`) : null),
      h('td', { class: 'muted job-sum' }, String(state).slice(0, 160)),
      h('td', {}, when(j.createdAt)),
      h('td', {}, ...buttons)));
    if (open) {
      const full = await api(`/api/jobs/${j.id}`).catch(() => null);
      if (full) rows.push(h('tr', {}, h('td', { colspan: 5 }, jobDetail(full))));
    }
  }
  $('#jobs-list').replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Job', 'Status', 'Latest', 'Queued', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'Nothing queued. Add a job above.')))));
  // Keep refreshing while this page is open: fast when something is active.
  clearTimeout(jobsTimer);
  if (current === 'jobs') jobsTimer = setTimeout(() => loadJobs().catch(() => {}), s.running || s.queued ? 2500 : 8000);
}
loaders.jobs = async () => { await loadProjects(); await loadJobs(); };
document.addEventListener('submit', (e) => { if (e.target.id === 'job-form') submitJobs(e); });


// ---- Config ----
function routeSummary(cfg) {
  return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Route'), h('th', {}, 'Tries in order'))),
    h('tbody', {}, Object.entries(cfg.routes).map(([r, v]) => h('tr', {}, h('td', {}, h('strong', {}, r === cfg.default ? `${r} (default)` : r)),
      h('td', {}, v.chain.map((c, i) => [i ? ' → ' : '', h('span', { class: 'pill' }, `${c} · ${cfg.connectors[c]?.model ?? '?'}`)]))))));
}
const cfgOriginal = {};
function setEditor(kind, value) {
  const text = JSON.stringify(value, null, 2);
  cfgOriginal[kind] = text;
  $(`#cfg-${kind}`).value = text;
  $(`#dirty-${kind}`).hidden = true;
}
loaders.config = async () => {
  const cfg = await loadConfig();
  $('#route-summary').replaceChildren(routeSummary(cfg));
  setEditor('routes', { connectors: cfg.connectors, routes: cfg.routes, default: cfg.default });
  setEditor('budgets', cfg.caps);
  for (const k of ['routes', 'budgets']) $(`#save-${k}`).disabled = !cfg.editable;
};
async function saveCfg(kind) {
  const msg = $(`#msg-${kind}`);
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  let body;
  try {
    body = JSON.parse($(`#cfg-${kind}`).value);
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = `Not valid JSON: ${err.message}`;
    return;
  }
  try {
    await api(`/api/config/${kind}`, { method: 'PUT', body });
    msg.className = 'msg ok';
    msg.textContent = 'Saved and applied.';
    toast(`${kind} saved`, 'ok');
    const cfg = await loadConfig();
    $('#route-summary').replaceChildren(routeSummary(cfg));
    cfgOriginal[kind] = $(`#cfg-${kind}`).value;
    $(`#dirty-${kind}`).hidden = true;
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = err.message;
  }
}
for (const kind of ['routes', 'budgets']) {
  const ta = $(`#cfg-${kind}`);
  $(`#save-${kind}`).addEventListener('click', () => saveCfg(kind));
  $(`#fmt-${kind}`).addEventListener('click', () => {
    try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); ta.dispatchEvent(new Event('input')); } catch (e) { toast(`Not valid JSON: ${e.message}`, 'bad'); }
  });
  $(`#reset-${kind}`).addEventListener('click', () => { ta.value = cfgOriginal[kind] ?? ''; ta.dispatchEvent(new Event('input')); });
  ta.addEventListener('input', () => ($(`#dirty-${kind}`).hidden = ta.value === cfgOriginal[kind]));
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCfg(kind); }
    else if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
  });
}

// ---- Terminal ----
let termAbort = null;
function runStreamed(path, body, out, stopBtn, runBtn) {
  out.textContent = '';
  termAbort = new AbortController();
  stopBtn.hidden = false;
  runBtn.disabled = true;
  const started = Date.now();
  return stream(path, body, (ev) => {
    if (ev.type === 'stdout' || ev.type === 'stderr') {
      const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.append(ev.stream === 'stderr' || ev.type === 'stderr' ? h('span', { class: 'err' }, ev.text) : ev.text);
      if (stick) out.scrollTop = out.scrollHeight;
    }
  }, termAbort.signal)
    .then((r) => out.append(h('span', { class: r.ok ? 'ok' : 'err' }, `\n[exit ${r.code}${r.timedOut ? ', timed out' : ''}${r.truncated ? ', output truncated' : ''} · ${secs(Date.now() - started)}]`)))
    .catch((err) => out.append(h('span', { class: 'err' }, `\n[${err.name === 'AbortError' ? 'stopped' : err.message}]`)))
    .finally(() => { termAbort = null; stopBtn.hidden = true; runBtn.disabled = false; });
}
// Interactive terminal: persistent shells (see src/terminal.mjs). Output replays from the server on reload.
const terms = new Map(); // id -> { id, shell, cwd, chunks, chars, seq, busy, dead, hist, histAt }
let activeTerm = null;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
const termHist = JSON.parse(localStorage.getItem('homeai-term') || '[]');
const termOut = () => $('#term-out');

function termPush(t, cls, text) {
  text = text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
  if (!text) return;
  t.chunks.push({ cls, text });
  t.chars += text.length;
  while (t.chars > 300_000 && t.chunks.length > 1) t.chars -= t.chunks.shift().text.length;
  if (t === activeTerm) {
    const out = termOut();
    const stick = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
    out.append(cls ? h('span', { class: cls }, text) : text);
    if (stick) out.scrollTop = out.scrollHeight;
  }
}
function termRender() {
  const t = activeTerm;
  const out = termOut();
  out.replaceChildren(...(t ? t.chunks.map((c) => (c.cls ? h('span', { class: c.cls }, c.text) : c.text)) : ['Open a terminal to start.']));
  out.scrollTop = out.scrollHeight;
  const cmd = $('#term-cmd');
  cmd.disabled = !t || t.dead;
  $('#term-prompt').textContent = t ? `${t.cwd}${t.busy ? ' …' : ' >'}` : '>';
  $('#term-tabs').replaceChildren(...[...terms.values()].map((x, i) => h('button', { class: `term-tab${x === t ? ' active' : ''}${x.dead ? ' dead' : ''}`, title: x.cwd, onclick: () => { activeTerm = x; termRender(); cmd.focus(); } }, `${i + 1}: ${x.shell}`)));
  for (const id of ['#term-interrupt', '#term-close']) $(id).disabled = !t;
}

// Follows one session's SSE stream (GET), reconnecting from the last seen sequence number.
async function termAttach(t) {
  while (!t.dead && terms.has(t.id)) {
    try {
      await bootstrapToken();
      const res = await fetch(`/api/terminal/${t.id}/stream?since=${t.seq}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: t.abort.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line) termEvent(t, JSON.parse(line.slice(6)));
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
    if (t.dead) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
function termEvent(t, ev) {
  if (ev.type === 'error') { t.dead = true; termPush(t, 'err', `\n[${ev.error}]\n`); termRender(); return; }
  if (ev.seq) t.seq = Math.max(t.seq, ev.seq);
  if (ev.type === 'out') termPush(t, ev.stream === 'stderr' ? 'err' : '', ev.text);
  else if (ev.type === 'notice') termPush(t, 'notice', ev.text);
  else if (ev.type === 'cwd') { t.cwd = ev.cwd; t.busy = false; if (t === activeTerm) termRender(); }
  else if (ev.type === 'exit') {
    t.dead = true;
    termPush(t, 'err', `\n[shell exited${ev.code != null ? ` with code ${ev.code}` : ''}${ev.error ? `: ${ev.error}` : ''}]\n`);
    t.abort.abort();
    if (ev.closed) terms.delete(t.id);
    if (activeTerm === t && ev.closed) activeTerm = [...terms.values()].pop() ?? null;
    termRender();
  }
}
function termAdd(s) {
  if (terms.has(s.id)) return terms.get(s.id);
  const t = { id: s.id, shell: s.shell, cwd: s.cwd, chunks: [], chars: 0, seq: 0, busy: false, dead: !!s.exited, abort: new AbortController() };
  terms.set(s.id, t);
  termAttach(t);
  return t;
}
async function termNew() {
  try {
    const s = await api('/api/terminal', { method: 'POST', body: { cwd: $('#term-cwd').value.trim() || undefined, shell: $('#term-shell').value } });
    activeTerm = termAdd(s);
    termRender();
    $('#term-cmd').focus();
  } catch (err) { toast(err.message, 'bad'); }
}
const termSend = (t, body) => api(`/api/terminal/${t.id}/input`, { method: 'POST', body }).catch((e) => termPush(t, 'err', `[${e.message}]\n`));

$('#term-new').addEventListener('click', termNew);
$('#term-clear').addEventListener('click', () => { if (activeTerm) { activeTerm.chunks = []; activeTerm.chars = 0; termRender(); } });
$('#term-interrupt').addEventListener('click', () => activeTerm && api(`/api/terminal/${activeTerm.id}/interrupt`, { method: 'POST', body: {} }).then(() => { activeTerm.busy = false; termRender(); }).catch((e) => toast(e.message, 'bad')));
$('#term-close').addEventListener('click', () => activeTerm && api(`/api/terminal/${activeTerm.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'bad')));
$('#term-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = activeTerm;
  const input = $('#term-cmd');
  if (!t || t.dead) return;
  const text = input.value;
  input.value = '';
  t.histAt = -1;
  if (t.busy) {
    // Something is running and may be waiting for this (a prompt or REPL), so send it as-is.
    termPush(t, 'cmd', `${text}\n`);
    termSend(t, { data: `${text}\n` });
    return;
  }
  if (text.trim()) {
    const i = termHist.indexOf(text);
    if (i >= 0) termHist.splice(i, 1);
    termHist.unshift(text);
    termHist.length = Math.min(termHist.length, 100);
    localStorage.setItem('homeai-term', JSON.stringify(termHist));
  }
  termPush(t, 'cmd', `${t.cwd}> ${text}\n`);
  if (!text.trim()) return;
  t.busy = true;
  termRender();
  termSend(t, { data: text, run: true });
});
$('#term-cmd').addEventListener('keydown', (e) => {
  const t = activeTerm;
  if (!t) return;
  const input = e.target;
  if (e.ctrlKey && e.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd) { e.preventDefault(); $('#term-interrupt').click(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); $('#term-clear').click(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    t.histAt = Math.max(-1, Math.min(termHist.length - 1, (t.histAt ?? -1) + (e.key === 'ArrowUp' ? 1 : -1)));
    input.value = t.histAt >= 0 ? termHist[t.histAt] : '';
  }
});
termOut().addEventListener('click', () => { if (!getSelection().toString()) $('#term-cmd').focus(); });
loaders.terminal = async () => {
  await loadProjects();
  const r = await api('/api/terminal');
  if (!$('#term-cwd').value) $('#term-cwd').value = r.default ?? '';
  for (const s of r.sessions) termAdd(s);
  if (!activeTerm) activeTerm = [...terms.values()][0] ?? null;
  if (!terms.size) await termNew();
  else termRender();
  $('#term-cmd').focus();
};

// ---- Projects & GitHub ----
function gitBtn(p, action, label, extra) {
  return h('button', { class: 'ghost sm', onclick: async (e) => {
    let message;
    if (action === 'sync') {
      message = await ask('Publish to GitHub', 'Commit message for the public repo. This publishes.');
      if (!message?.trim()) return;
    }
    const btns = $$('button', e.target.parentElement);
    btns.forEach((b) => (b.disabled = true));
    const out = $('#proj-out');
    const path = `/api/projects/${encodeURIComponent(p.name)}/${action === 'test' ? 'test' : 'git'}`;
    const body = action === 'test' ? {} : { action, message };
    try {
      await runStreamed(path, body, out, h('button', { hidden: true }), h('button'));
      out.prepend(h('span', { class: 'ok' }, `$ ${extra ?? action} (${p.name})\n`));
    } finally { btns.forEach((b) => (b.disabled = false)); }
  } }, label);
}
async function loadGithub() {
  const msg = $('#gh-msg');
  msg.textContent = 'Loading…';
  try {
    const [s, i] = await Promise.all([api('/api/github'), api('/api/github/issues?state=open')]);
    msg.textContent = '';
    $('#gh-repo').textContent = s.repo;
    $('#gh-summary').replaceChildren(
      h('p', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.url), ` · ${s.private ? 'private' : 'public'} · default branch ${s.defaultBranch} · ${s.openIssues} open`),
      h('div', { class: 'grid-2' },
        h('table', {}, h('thead', {}, h('tr', {}, ['Commit', 'Message', 'When'].map((x) => h('th', {}, x)))), h('tbody', {}, s.commits.map((c) => h('tr', {}, h('td', { class: 'mono' }, c.sha), h('td', {}, c.message), h('td', {}, when(c.date)))))),
        s.runs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['CI run', 'Branch', 'Result'].map((x) => h('th', {}, x)))), h('tbody', {}, s.runs.map((r) => h('tr', {}, h('td', {}, h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.name)), h('td', {}, r.branch), h('td', {}, h('span', { class: `pill ${r.conclusion === 'success' ? 'ok' : r.conclusion ? 'bad' : 'warn'}` }, r.conclusion ?? r.status)))))) : h('p', { class: 'muted' }, 'No CI runs.')));
    $('#gh-issues').replaceChildren(i.issues.length
      ? h('table', {}, h('tbody', {}, i.issues.map((x) => h('tr', {}, h('td', {}, x.pullRequest ? 'PR' : 'Issue'), h('td', {}, h('a', { href: x.url, target: '_blank', rel: 'noopener' }, `#${x.number} ${x.title}`)), h('td', { class: 'muted' }, x.user)))))
      : h('p', { class: 'muted' }, 'Nothing open.'));
  } catch (err) {
    msg.textContent = err.message;
  }
}
$('#gh-refresh').addEventListener('click', loadGithub);
$('#gh-create').addEventListener('click', async () => {
  const m = $('#gh-create-msg');
  const title = $('#gh-title').value.trim();
  if (!title) return;
  if (!confirm(`Create a public GitHub issue titled "${title}"?`)) return;
  m.className = 'msg';
  m.textContent = 'Creating…';
  try {
    const r = await api('/api/github/issues', { method: 'POST', body: { title, body: $('#gh-body').value } });
    m.className = 'msg ok';
    m.textContent = `Created #${r.number}`;
    $('#gh-title').value = $('#gh-body').value = '';
    loadGithub();
  } catch (err) {
    m.className = 'msg bad';
    m.textContent = err.message;
  }
});
loaders.projects = async () => {
  await loadProjects();
  $('#projects-table').replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Project', 'Folder', 'Actions'].map((t) => h('th', {}, t)))),
    h('tbody', {}, projects.map((p) => h('tr', {}, h('td', {}, h('strong', {}, p.name), h('div', { class: 'muted' }, p.description)), h('td', { class: 'mono' }, p.path),
      h('td', {}, h('span', { class: 'row' },
        p.canTest ? gitBtn(p, 'test', 'Run tests', 'tests') : null,
        p.git ? ['status', 'log', 'diff'].map((a) => gitBtn(p, a, a, `git ${a}`)) : null,
        p.canSync ? gitBtn(p, 'sync', 'Publish to GitHub', 'sync') : null)))))));
  loadGithub();
};

// ---- Memory ----
let editing = null;
async function loadMemory() {
  const q = $('#mem-search').value.trim();
  const { notes } = await api(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#mem-list').replaceChildren(...(notes.length
    ? notes.map((x) => h('div', { class: 'note' },
      h('h4', {}, x.title), h('p', {}, x.text),
      h('div', { class: 'tags' }, x.tags.map((t) => h('span', { class: `pill ${t === 'core' ? 'ok' : ''}` }, t))),
      h('div', { class: 'acts' },
        h('button', { class: 'ghost sm', onclick: () => { editing = x.id; $('#mem-form-title').textContent = 'Edit note'; $('#mem-title').value = x.title; $('#mem-text').value = x.text; $('#mem-tags').value = x.tags.join(', '); $('#mem-cancel').hidden = false; $('#mem-title').focus(); } }, 'Edit'),
        h('button', { class: 'ghost sm danger', onclick: async () => { if (!confirm(`Delete "${x.title}"? It moves to the memory trash.`)) return; await api(`/api/memory/${x.id}`, { method: 'DELETE' }); toast('Moved to trash', 'ok'); loadMemory(); } }, 'Delete'))))
    : [h('p', { class: 'muted' }, 'No notes.')]));
}
function resetMemForm() {
  editing = null;
  $('#mem-form').reset();
  $('#mem-form-title').textContent = 'Add a note';
  $('#mem-cancel').hidden = true;
}
$('#mem-cancel').addEventListener('click', resetMemForm);
$('#mem-refresh').addEventListener('click', loadMemory);
$('#mem-search').addEventListener('input', () => loadMemory());
$('#mem-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const m = $('#mem-msg');
  const body = { title: $('#mem-title').value, text: $('#mem-text').value, tags: $('#mem-tags').value.split(',').map((t) => t.trim()).filter(Boolean) };
  try {
    await (editing ? api(`/api/memory/${editing}`, { method: 'PATCH', body }) : api('/api/memory', { method: 'POST', body }));
    m.textContent = '';
    toast('Note saved', 'ok');
    resetMemForm();
    loadMemory();
  } catch (err) {
    m.className = 'msg bad';
    m.textContent = err.message;
  }
});
loaders.memory = loadMemory;

// ---- Devices ----
async function loadDevices() {
  $('#whoami').textContent = whoami ? `This browser is signed in as "${whoami.name}" (${whoami.scopes.join(', ')})` : '';
  const { devices } = await api('/api/devices');
  $('#dev-list').replaceChildren(devices.length
    ? h('table', {}, h('thead', {}, h('tr', {}, ['Device', 'Access', 'Created', 'Last seen', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, devices.map((d) => h('tr', {}, h('td', {}, h('strong', {}, d.name)), h('td', {}, d.scopes.map((s) => h('span', { class: 'pill' }, s))), h('td', {}, when(d.created)), h('td', {}, d.lastSeen ? when(d.lastSeen) : 'never'),
        h('td', {}, h('button', { class: 'ghost sm danger', onclick: async () => { if (!confirm(`Revoke "${d.name}"? Its token stops working immediately.`)) return; await api(`/api/devices/${d.id}`, { method: 'DELETE' }); toast('Revoked', 'ok'); loadDevices(); } }, 'Revoke'))))))
    : h('p', { class: 'muted' }, 'No extra devices yet.'));
}
$('#dev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const m = $('#dev-msg');
  const scopes = $$('#dev-form input[name=scope]:checked').map((x) => x.value);
  try {
    const r = await api('/api/devices', { method: 'POST', body: { name: $('#dev-name').value, scopes } });
    m.className = 'msg ok';
    m.textContent = 'Created.';
    const box = $('#dev-token');
    box.hidden = false;
    box.replaceChildren(h('strong', {}, `Token for ${r.device.name} (shown once, copy it now):`), h('pre', { class: 'term' }, r.token), h('button', { class: 'sm', onclick: () => copyText(r.token) }, 'Copy token'));
    $('#dev-name').value = '';
    loadDevices();
  } catch (err) {
    m.className = 'msg bad';
    m.textContent = err.message;
  }
});
loaders.devices = loadDevices;

// ---- Connections (account logins, kept encrypted on this PC) ----
let devicePollTimer = null;
function connCard(c) {
  const state = c.connected ? h('span', { class: 'pill ok' }, `connected as ${c.account}`) : c.needsLogin ? h('span', { class: 'pill warn' }, 'needs a new login') : h('span', { class: 'pill' }, 'not connected');
  const msg = h('span', { class: 'msg' });
  const field = h('input', { type: 'password', autocomplete: 'off', placeholder: c.id === 'github' ? 'Personal access token (github_pat_… or ghp_…)' : 'Token or API key', size: 44, 'aria-label': `${c.name} token` });
  const done = async (fn, okText) => {
    msg.className = 'msg';
    msg.textContent = 'Working…';
    try { await fn(); msg.className = 'msg ok'; msg.textContent = okText; toast(okText, 'ok'); await loadConnections(); } catch (err) { msg.className = 'msg bad'; msg.textContent = err.message; }
  };
  const save = () => {
    const secret = field.value;
    field.value = '';
    return done(() => api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'POST', body: { secret } }), `${c.name} connected`);
  };
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const device = h('div', { class: 'mt', hidden: true });
  return h('div', { class: 'panel mt' },
    h('div', { class: 'panel-head' }, h('h3', {}, c.name), state),
    h('p', { class: 'muted' }, c.description),
    h('div', { class: 'row' }, field, h('button', { class: 'primary', onclick: save }, c.connected ? 'Replace token' : 'Connect'),
      c.deviceFlow ? h('button', { class: 'ghost', onclick: () => startDeviceLogin(device, msg) }, 'Sign in with GitHub') : null,
      c.connected || c.needsLogin ? h('button', { class: 'ghost danger', onclick: async () => { if (confirm(`Disconnect ${c.name}? The saved login is deleted from this PC.`)) done(() => api(`/api/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' }), `${c.name} disconnected`); } }, 'Disconnect') : null,
      msg),
    device);
}
async function startDeviceLogin(box, msg) {
  clearInterval(devicePollTimer);
  try {
    const d = await api('/api/connections/github/device', { method: 'POST', body: {} });
    box.hidden = false;
    box.replaceChildren(h('p', {}, 'Open ', h('a', { href: d.verificationUri, target: '_blank', rel: 'noopener' }, d.verificationUri), ' and enter this code:'), h('p', { class: 'mono big' }, d.userCode), h('p', { class: 'muted' }, 'Waiting for you to approve…'));
    let every = Math.max(d.interval, 5) * 1000;
    const tick = async () => {
      try {
        const r = await api('/api/connections/github/device/poll', { method: 'POST', body: {} });
        if (r.status === 'connected') { box.hidden = true; toast(`GitHub connected as ${r.account}`, 'ok'); loadConnections(); return; }
        if (r.slowDown) every += 5000;
        devicePollTimer = setTimeout(tick, every);
      } catch (err) { box.hidden = true; msg.className = 'msg bad'; msg.textContent = err.message; }
    };
    devicePollTimer = setTimeout(tick, every);
  } catch (err) { msg.className = 'msg bad'; msg.textContent = err.message; }
}
async function loadConnections() {
  const { connections } = await api('/api/connections');
  $('#conn-list').replaceChildren(...connections.map(connCard));
}
loaders.connections = loadConnections;

// ---- Settings ----
const SHORTCUTS = [
  ['Ctrl+K', 'Command palette'], ['Ctrl+B', 'Collapse or expand the sidebar'], ['Ctrl+Shift+O', 'New chat'], ['Alt+1…9', 'Jump to the Nth page'],
  ['Enter / Shift+Enter', 'Send / newline in the composer'], ['↑ in empty composer', 'Recall previous prompts'], ['/', 'Slash commands (/new /route /model /export /theme /go)'],
  ['Ctrl+S', 'Save inside a config editor'], ['Esc', 'Close dialogs and menus'],
];
function seg(el, options, key, after) {
  el.replaceChildren(...options.map(([v, l]) => h('button', { type: 'button', class: ui[key] === v ? 'on' : '', onclick: () => { ui[key] = v; saveUi(); applyUi(); after?.(); seg(el, options, key, after); } }, l)));
}
function renderSettings() {
  seg($('#theme-seg'), [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']], 'theme');
  seg($('#density-seg'), [['comfortable', 'Comfortable'], ['compact', 'Compact']], 'density');
  seg($('#width-seg'), [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']], 'width');
  $('#accent-swatches').replaceChildren(...ACCENTS.map((c) => h('button', { type: 'button', class: `swatch${ui.accent === c ? ' on' : ''}`, style: `background:${c}`, title: c, 'aria-label': `Accent ${c}`, onclick: () => { ui.accent = c; saveUi(); applyUi(); renderSettings(); } })));
  $('#set-enter').checked = ui.enterSends;
  $('#set-meta').checked = ui.showMeta;
  $('#shortcut-table').replaceChildren(...SHORTCUTS.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d))));
}
$('#set-enter').addEventListener('change', (e) => { ui.enterSends = e.target.checked; saveUi(); });
$('#set-meta').addEventListener('change', (e) => { ui.showMeta = e.target.checked; saveUi(); renderThread(); });
$('#forget-token').addEventListener('click', () => { token = ''; localStorage.removeItem('homeai-token'); toast('Token forgotten; it will be fetched again', 'ok'); });
loaders.settings = async () => renderSettings();
function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  ui.theme = order[(order.indexOf(ui.theme) + 1) % order.length];
  saveUi();
  applyUi();
  toast(`Theme: ${ui.theme}`, 'ok');
}
$('#theme-quick').addEventListener('click', cycleTheme);

// ---- Sidebar ----
function toggleSidebar() {
  if (window.matchMedia('(max-width: 860px)').matches) {
    const open = $('#app').classList.toggle('menu-open');
    $('#scrim').hidden = !open;
  } else {
    ui.collapsed = !ui.collapsed;
    saveUi();
    applyUi();
  }
}
$('#collapse').addEventListener('click', toggleSidebar);
$('#menu').addEventListener('click', toggleSidebar);
$('#scrim').addEventListener('click', toggleSidebar);

// ---- Resizable sidebar ----
(() => {
  const handle = $('#side-resize');
  const setW = (w, save) => {
    ui.sideW = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(w)));
    applySideWidth();
    if (save) saveUi();
  };
  handle.addEventListener('pointerdown', (e) => {
    if (ui.collapsed) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    $('#app').classList.add('resizing');
    const left = $('#sidebar').getBoundingClientRect().left;
    const move = (ev) => setW(ev.clientX - left, false);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      $('#app').classList.remove('resizing');
      saveUi();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => { ui.sideW = 0; applySideWidth(); saveUi(); toast('Sidebar width reset', 'ok'); });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setW($('#sidebar').getBoundingClientRect().width + (e.key === 'ArrowRight' ? 16 : -16), true);
  });
})();

// ---- Top-right controls ----
$('#top-new').addEventListener('click', () => { show('chat'); openConversation(null); });
$('#top-search').addEventListener('click', () => openPalette());
$('#top-theme').addEventListener('click', () => cycleTheme());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintThemeButton);
function closeUserMenu() {
  $('#user-menu').hidden = true;
  $('#who').setAttribute('aria-expanded', 'false');
}
function openUserMenu() {
  const isAdmin = whoami?.scopes.includes('admin');
  const go = (tab) => () => { closeUserMenu(); show(tab); };
  const item = (label, fn) => h('button', { type: 'button', role: 'menuitem', onclick: fn }, label);
  $('#user-menu').replaceChildren(
    h('div', { class: 'mh' }, h('strong', {}, whoami?.name ?? 'Unknown'), h('small', {}, `Access: ${(whoami?.scopes ?? []).join(', ') || 'none'}`)),
    item('Settings', go('settings')),
    isAdmin ? item('Devices and tokens', go('devices')) : null,
    isAdmin ? item('Connections', go('connections')) : null,
    item('Keyboard shortcuts', go('settings')),
    h('div', { class: 'msep' }),
    item('Enter a different token…', async () => { closeUserMenu(); await askToken(); whoami = await api('/api/whoami').catch(() => null); applyFeatures(); toast('Token updated', 'ok'); }),
    item('Forget saved token', () => { closeUserMenu(); $('#forget-token').click(); }),
    item('Reload settings from the service', async () => { closeUserMenu(); try { await loadConfig(); applyFeatures(); await loadConversations(); toast('Reloaded', 'ok'); } catch (e) { toast(e.message, 'bad'); } }),
  );
  $('#user-menu').hidden = false;
  $('#who').setAttribute('aria-expanded', 'true');
  $('#user-menu button')?.focus();
}
$('#who').addEventListener('click', (e) => { e.stopPropagation(); if ($('#user-menu').hidden) openUserMenu(); else closeUserMenu(); });
document.addEventListener('click', (e) => { if (!$('#user-menu').hidden && !e.target.closest('.menu-wrap')) closeUserMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#user-menu').hidden) { closeUserMenu(); $('#who').focus(); } });

// ---- Command palette ----
let palIdx = 0;
let palItems = [];
function paletteCommands(q) {
  const items = [];
  for (const t of TABS) {
    const el = $(`.nav-item[data-nav="${t.id}"]`);
    if (el && !el.hidden) items.push({ group: 'Go to', label: t.id === 'chat' ? 'Chat (current conversation)' : t.label, hint: SUBS[t.id], run: () => show(t.id) });
  }
  items.push({ group: 'Go to', label: 'All chats', hint: SUBS.chats, run: () => show('chats') });
  items.push({ group: 'Go to', label: 'Settings', hint: SUBS.settings, run: () => show('settings') });
  items.push(
    { group: 'Actions', label: 'New chat', hint: 'Ctrl+Shift+O', run: () => { show('chat'); openConversation(null); } },
    { group: 'Actions', label: 'Toggle sidebar', hint: 'Ctrl+B', run: toggleSidebar },
    { group: 'Actions', label: 'Reset sidebar width', hint: '', run: () => { ui.sideW = 0; applySideWidth(); saveUi(); } },
    ...(convId ? [{ group: 'Actions', label: 'Archive this chat', hint: '', run: () => archiveConv(convId, $('#conv-title').textContent) }, { group: 'Actions', label: 'Delete this chat', hint: 'kept in trash', run: () => trashConv(convId, $('#conv-title').textContent) }] : []),
    { group: 'Actions', label: 'Cycle theme', hint: ui.theme, run: cycleTheme },
    { group: 'Actions', label: 'Check service status now', hint: '', run: () => { show('status'); loadStatus(true).catch((e) => toast(e.message, 'bad')); } },
  );
  for (const r of Object.keys(config?.routes ?? {})) items.push({ group: 'Route', label: `Use route: ${r}`, hint: r === config.default ? 'default' : '', run: () => { show('chat'); setRoute(r); } });
  for (const [name, c] of Object.entries(config?.connectors ?? {})) items.push({ group: 'Model', label: `Pin model: ${name}`, hint: c.model, run: () => { show('chat'); setModel(name); } });
  for (const c of convs.slice(0, 40)) items.push({ group: 'Conversations', label: c.title, hint: when(c.updated), run: () => { show('chat'); openConversation(c.id); } });
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => terms.every((t) => `${i.label} ${i.group}`.toLowerCase().includes(t))).slice(0, 40);
}
function renderPalette() {
  palItems = paletteCommands($('#palette-input').value);
  palIdx = Math.min(palIdx, Math.max(palItems.length - 1, 0));
  const list = $('#palette-list');
  list.replaceChildren();
  if (!palItems.length) return list.append(h('p', { class: 'muted', style: 'padding:12px' }, 'Nothing matches.'));
  let g = '';
  palItems.forEach((it, i) => {
    if (it.group !== g) { g = it.group; list.append(h('div', { class: 'p-group' }, g)); }
    list.append(h('div', { class: `p-item${i === palIdx ? ' on' : ''}`, role: 'option', onclick: () => runPalette(i) }, h('span', {}, it.label), h('span', { class: 'hint' }, it.hint)));
  });
  $('.p-item.on', list)?.scrollIntoView({ block: 'nearest' });
}
function runPalette(i) {
  const it = palItems[i];
  $('#palette').close();
  it?.run();
}
function openPalette() {
  const dlg = $('#palette');
  if (dlg.open) return;
  $('#palette-input').value = '';
  palIdx = 0;
  renderPalette();
  dlg.showModal();
  $('#palette-input').focus();
}
$('#open-palette').addEventListener('click', openPalette);
$('#palette-input').addEventListener('input', () => { palIdx = 0; renderPalette(); });
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = (palIdx + 1) % Math.max(palItems.length, 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = (palIdx - 1 + palItems.length) % Math.max(palItems.length, 1); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(palIdx); }
});
$('#palette').addEventListener('click', (e) => { if (e.target === $('#palette')) $('#palette').close(); });

// ---- Global shortcuts ----
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleSidebar(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); show('chat'); openConversation(null); }
  else if (e.altKey && /^[1-9]$/.test(e.key)) {
    const visible = TABS.filter((t) => !$(`.nav-item[data-nav="${t.id}"]`)?.hidden);
    const t = visible[Number(e.key) - 1];
    if (t) { e.preventDefault(); show(t.id); }
  }
});

// ---- Boot ----
buildNav();
paintIcons();
applyUi();
health();
setInterval(health, 30_000);
(async () => {
  await bootstrapToken();
  whoami = await api('/api/whoami').catch(() => null);
  await loadConfig().catch(() => {});
  applyFeatures();
  const start = location.hash.slice(1);
  show(TITLES[start] ? start : 'chat');
  const lastChat = localStorage.getItem('homeai-last-conversation');
  if ((!start || start === 'chat') && lastChat) await openConversation(lastChat).catch(() => toast('Your last chat is saved. Reopen it when the service reconnects.', 'bad'));
})();
