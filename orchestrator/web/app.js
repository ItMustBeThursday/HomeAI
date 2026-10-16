// HomeAI Orchestrator WebUI. Plain ES module, no build step. Model output is only ever set via
// textContent, never innerHTML.
const $ = (sel) => document.querySelector(sel);
const fmt = new Intl.NumberFormat();
const n = (v) => fmt.format(v ?? 0);
const secs = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`);
const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

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

// On this PC the service hands the admin token to the WebUI; elsewhere it answers 403 and we fall back to asking.
async function bootstrapToken() {
  if (token) return;
  try {
    const r = await fetch('/api/bootstrap');
    if (r.ok) token = (await r.json()).token || '';
  } catch { /* ignore */ }
}

// POST that reads a server-sent-event stream. onEvent gets each event; resolves with the 'done' event.
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

// ---- Tabs ----
const loaders = {};
let current = 'chat';
function show(tab) {
  current = tab;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === `tab-${tab}`);
  history.replaceState(null, '', `#${tab}`);
  loaders[tab]?.().catch((err) => console.error(err));
}
$('#tabs').addEventListener('click', (e) => e.target.dataset.tab && show(e.target.dataset.tab));

// ---- Health ----
async function health() {
  const el = $('#health');
  try {
    const r = await fetch('/api/health').then((x) => x.json());
    el.className = 'health ok';
    el.textContent = `v${r.version}`;
  } catch {
    el.className = 'health bad';
    el.textContent = 'offline';
  }
}

// ---- Config cache (routes/connectors) ----
let config = null;
async function loadConfig() {
  config = await api('/api/config');
  const route = $('#route');
  const prevRoute = route.value;
  route.replaceChildren(...Object.keys(config.routes).map((r) => h('option', { value: r }, r === config.default ? `${r} (default)` : r)));
  route.value = prevRoute && config.routes[prevRoute] ? prevRoute : config.default;
  const pin = $('#pin');
  const prevPin = pin.value;
  pin.replaceChildren(h('option', { value: '' }, 'Auto (route chain)'), ...Object.entries(config.connectors).map(([name, c]) => h('option', { value: name }, `${name} — ${c.model}`)));
  pin.value = prevPin && config.connectors[prevPin] ? prevPin : '';
  return config;
}

// ---- Chat ----
let convId = null;
let sending = false;

function renderText(text) {
  // Split fenced code blocks out; everything else is plain paragraphs.
  const parts = String(text).split(/```[^\n]*\n?/);
  return parts.map((part, i) => (i % 2 ? h('pre', {}, part.replace(/\n$/, '')) : part.trim() ? h('p', {}, part.trim()) : null));
}

function botMeta(m) {
  const bits = [];
  if (m.connector) bits.push(`${m.connector} · ${m.model}`);
  if (m.taskType) bits.push(`route ${m.taskType}`);
  if (m.ms != null) bits.push(secs(m.ms));
  const meta = h('div', { class: 'meta' }, bits.join(' · '));
  if (m.attempts?.length) {
    const tokens = m.attempts.reduce((s, a) => s + (a.inputTokens || 0) + (a.outputTokens || 0), 0);
    meta.append(` · ${n(tokens)} tokens`);
    if (m.attempts.length > 1) {
      meta.append(' · ', h('details', {}, h('summary', {}, `${m.attempts.length} attempts`), h('div', {}, ...m.attempts.map(attemptLine))));
    }
  }
  return meta;
}

function attemptLine(a) {
  const state = a.skipped ? `skipped: ${a.skipped}` : a.ok ? `ok in ${secs(a.ms)}` : `failed in ${secs(a.ms)}: ${a.error}`;
  return h('div', {}, `${a.connector} (${a.model}) — ${state}`);
}

function addMessage(m) {
  const thread = $('#thread');
  thread.querySelector('.empty')?.remove();
  if (m.role === 'user') thread.append(h('div', { class: 'msg-user' }, m.text));
  else if (m.error) thread.append(h('div', { class: 'msg-bot error' }, h('p', {}, `No answer: ${m.error}`), botMeta(m)));
  else thread.append(h('div', { class: 'msg-bot' }, renderText(m.text), botMeta(m)));
  thread.scrollTop = thread.scrollHeight;
}

async function loadConversations() {
  const { conversations } = await api('/api/conversations');
  $('#conv-list').replaceChildren(...conversations.map((c) => h('li', { class: c.id === convId ? 'active' : '', title: `${c.title}\n${when(c.updated)} · ${c.count} messages`, onclick: () => openConversation(c.id) }, c.title)));
}

async function openConversation(id) {
  convId = id;
  const thread = $('#thread');
  thread.replaceChildren();
  $('#rename-chat').hidden = $('#archive-chat').hidden = !id;
  if (!id) {
    $('#conv-title').textContent = 'New chat';
    thread.append(h('p', { class: 'empty' }, 'Ask anything. The route decides which model answers; you can pin one below.'));
  } else {
    const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
    $('#conv-title').textContent = conv.title;
    if (conv.taskType && config?.routes[conv.taskType]) $('#route').value = conv.taskType;
    conv.messages.forEach(addMessage);
  }
  await loadConversations();
  $('#prompt').focus();
}

$('#new-chat').addEventListener('click', () => openConversation(null));
$('#rename-chat').addEventListener('click', async () => {
  const title = prompt('New title', $('#conv-title').textContent);
  if (!title?.trim()) return;
  await api(`/api/conversations/${encodeURIComponent(convId)}`, { method: 'PATCH', body: { title } });
  $('#conv-title').textContent = title.trim();
  loadConversations();
});
$('#archive-chat').addEventListener('click', async () => {
  if (!confirm('Archive this conversation? It is moved to data/conversations/archive, not deleted.')) return;
  await api(`/api/conversations/${encodeURIComponent(convId)}`, { method: 'DELETE' });
  openConversation(null);
});

// ---- Image attachments ----
let pending = []; // [{ name, mediaType, data, url }]
const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function renderAttachments() {
  const strip = $('#attach-strip');
  strip.hidden = !pending.length;
  strip.replaceChildren(...pending.map((p, i) => h('span', { class: 'thumb' }, h('img', { src: p.url, alt: p.name }), h('button', { type: 'button', class: 'ghost', title: 'Remove', onclick: () => { URL.revokeObjectURL(p.url); pending.splice(i, 1); renderAttachments(); } }, '×'))));
}

async function addFiles(files) {
  for (const f of files) {
    if (!IMG_TYPES.includes(f.type)) { $('#busy').textContent = `${f.name}: not an image type I can send`; continue; }
    if (pending.length >= 4) { $('#busy').textContent = 'At most 4 images per message'; break; }
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
$('#composer').addEventListener('dragover', (e) => e.preventDefault());
$('#composer').addEventListener('drop', (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });

// ---- Streaming send ----
let chatAbort = null;
$('#stop').addEventListener('click', () => chatAbort?.abort());

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending) return;
  const text = $('#prompt').value.trim();
  if (!text) return;
  sending = true;
  $('#send').disabled = true;
  $('#stop').hidden = false;
  const images = pending.map(({ name, mediaType, data }) => ({ name, mediaType, data }));
  addMessage({ role: 'user', text: images.length ? `${text}\n[${images.length} image${images.length > 1 ? 's' : ''} attached]` : text });
  $('#prompt').value = '';
  // Live bubble: text arrives as deltas, tool use and fallbacks show as status lines.
  const thread = $('#thread');
  const live = h('div', { class: 'msg-bot live' });
  const body = h('p', {}, '');
  const status = h('div', { class: 'meta' }, 'Starting…');
  live.append(body, status);
  thread.append(live);
  let acc = '';
  const started = Date.now();
  const tick = setInterval(() => ($('#busy').textContent = secs(Date.now() - started)), 250);
  chatAbort = new AbortController();
  try {
    const r = await stream('/api/chat', {
      conversationId: convId ?? undefined, prompt: text, taskType: $('#route').value, connector: $('#pin').value || undefined,
      images: images.length ? images : undefined, project: $('#project-label').hidden ? undefined : $('#project').value || undefined,
    }, (ev) => {
      if (ev.type === 'attempt') { acc = ''; body.textContent = ''; status.textContent = `${ev.connector} · ${ev.model}…`; }
      else if (ev.type === 'delta') { acc += ev.text; body.textContent = acc; }
      else if (ev.type === 'tool') status.textContent = `${ev.connector ?? ''} ${ev.name}: ${ev.summary ?? ''}`.trim();
      else if (ev.type === 'attempt-failed') status.textContent = `${ev.connector} failed (${ev.error}); trying next…`;
      thread.scrollTop = thread.scrollHeight;
    }, chatAbort.signal);
    live.remove();
    const isNew = !convId;
    convId = r.conversation.id;
    if (isNew) $('#conv-title').textContent = r.conversation.title;
    $('#rename-chat').hidden = $('#archive-chat').hidden = false;
    addMessage({ role: 'assistant', ...r.reply });
    pending = [];
    renderAttachments();
    loadConversations();
  } catch (err) {
    live.remove();
    const stopped = err.name === 'AbortError';
    addMessage({ role: 'assistant', error: stopped ? 'Stopped' : err.message, ...(stopped && acc ? { text: acc } : {}) });
    $('#prompt').value = text;
  } finally {
    clearInterval(tick);
    chatAbort = null;
    $('#busy').textContent = '';
    $('#send').disabled = false;
    $('#stop').hidden = true;
    sending = false;
  }
});

// Agent route needs a project folder to work in.
function syncProjectPicker() {
  const agent = !!config?.routes[$('#route').value]?.agent;
  $('#project-label').hidden = !agent || !config?.features.shell;
}
$('#route').addEventListener('change', syncProjectPicker);
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit();
});

let projects = [];
async function loadProjects() {
  if (!config?.features.shell) return;
  const r = await api('/api/projects').catch(() => null);
  if (!r) return;
  projects = r.projects;
  const opts = () => projects.map((p) => h('option', { value: p.name }, p.name === r.default ? `${p.name} (default)` : p.name));
  for (const id of ['#project', '#term-project']) {
    const el = $(id);
    const prev = el.value;
    el.replaceChildren(...opts());
    el.value = prev && projects.some((p) => p.name === prev) ? prev : r.default;
  }
}

loaders.chat = async () => {
  await loadConfig();
  applyFeatures();
  await Promise.all([loadConversations(), loadProjects()]);
  syncProjectPicker();
};

// Hide tabs/controls for features the service has not enabled, or that this token cannot use.
let whoami = null;
function applyFeatures() {
  const f = config.features;
  const isAdmin = whoami?.scopes.includes('admin');
  for (const el of document.querySelectorAll('[data-feature]')) {
    const k = el.dataset.feature;
    el.hidden = !f[k] || (['shell', 'devices'].includes(k) && !isAdmin);
  }
}

// ---- Usage ----
function totalsTable(rows, label) {
  const entries = Object.entries(rows).sort((a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens));
  if (!entries.length) return h('p', { class: 'muted' }, 'No calls in this window.');
  return h('table', {},
    h('tr', {}, h('th', {}, label), h('th', { class: 'num' }, 'Calls'), h('th', { class: 'num' }, 'Input'), h('th', { class: 'num' }, 'Output'), h('th', { class: 'num' }, 'Cost')),
    entries.map(([k, t]) => h('tr', {}, h('td', {}, k), h('td', { class: 'num' }, n(t.calls)), h('td', { class: 'num' }, n(t.inputTokens)), h('td', { class: 'num' }, n(t.outputTokens)), h('td', { class: 'num' }, t.costUsd ? `$${t.costUsd.toFixed(4)}` : '—'))));
}

loaders.usage = async () => {
  const u = await api(`/api/usage?hours=${$('#usage-hours').value}`);
  const t = u.total;
  $('#usage-totals').replaceChildren(
    h('div', { class: 'card' }, h('div', { class: 'k' }, 'Calls'), h('div', { class: 'v' }, n(t.calls))),
    h('div', { class: 'card' }, h('div', { class: 'k' }, 'Tokens in'), h('div', { class: 'v' }, n(t.inputTokens))),
    h('div', { class: 'card' }, h('div', { class: 'k' }, 'Tokens out'), h('div', { class: 'v' }, n(t.outputTokens))),
    h('div', { class: 'card' }, h('div', { class: 'k' }, 'Reported cost (API-equivalent)'), h('div', { class: 'v' }, `$${t.costUsd.toFixed(4)}`)),
  );
  $('#usage-caps').replaceChildren(u.caps.length
    ? h('table', {}, h('tr', {}, h('th', {}, 'Cap'), h('th', {}, 'Metric'), h('th', {}, ''), h('th', { class: 'num' }, 'Used / limit')),
      u.caps.map((c) => {
        const pct = c.limit ? Math.min(100, (100 * c.used) / c.limit) : 100;
        const cls = pct >= 100 ? 'bar bad' : pct >= 80 ? 'bar warn' : 'bar';
        return h('tr', {}, h('td', {}, `${c.scope} ${c.name}`), h('td', {}, c.metric), h('td', {}, h('div', { class: cls }, h('span', { style: `width:${pct}%` }))), h('td', { class: 'num' }, `${n(c.used)} / ${n(c.limit)}`));
      }))
    : h('p', { class: 'muted' }, 'No budgets configured.'));
  $('#usage-conn').replaceChildren(totalsTable(u.byConnector, 'Connector'));
  $('#usage-route').replaceChildren(totalsTable(u.byTaskType, 'Route'));
};
$('#usage-hours').addEventListener('change', () => loaders.usage());
$('#usage-refresh').addEventListener('click', () => loaders.usage());

// ---- History ----
loaders.history = async () => {
  const { tasks } = await api('/api/history?limit=200');
  if (!tasks.length) return $('#history').replaceChildren(h('p', { class: 'muted' }, 'No tasks yet.'));
  const table = h('table', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Source'), h('th', {}, 'Route'), h('th', {}, 'Answered by'), h('th', {}, 'Result'), h('th', { class: 'num' }, 'Time'), h('th', { class: 'num' }, 'Tokens')));
  for (const t of tasks) {
    const tokens = (t.attempts ?? []).reduce((s, a) => s + (a.inputTokens || 0) + (a.outputTokens || 0), 0);
    const fellBack = (t.attempts?.length ?? 0) > 1;
    const row = h('tr', { class: 'click' },
      h('td', {}, when(t.ts)), h('td', {}, t.source ?? 'api'), h('td', {}, t.taskType),
      h('td', {}, t.connector ?? '—', t.pinned ? ' (pinned)' : ''),
      h('td', {}, h('span', { class: `pill ${t.ok ? (fellBack ? 'warn' : 'ok') : 'bad'}` }, t.ok ? (fellBack ? 'ok after fallback' : 'ok') : 'failed')),
      h('td', { class: 'num' }, secs(t.ms)), h('td', { class: 'num' }, n(tokens)));
    const detail = h('tr', { class: 'detail', hidden: true }, h('td', { colspan: 7 },
      h('strong', {}, 'Prompt'), h('div', {}, t.prompt ?? ''),
      h('strong', {}, t.ok ? 'Answer' : 'Error'), h('div', {}, t.ok ? t.text ?? '' : t.error ?? ''),
      h('strong', {}, 'Attempts'), (t.attempts ?? []).map(attemptLine)));
    row.addEventListener('click', () => (detail.hidden = !detail.hidden));
    table.append(row, detail);
  }
  $('#history').replaceChildren(table);
};
$('#history-refresh').addEventListener('click', () => loaders.history());

// ---- Status ----
async function loadStatus(fresh) {
  $('#status-time').textContent = 'Checking…';
  const s = await api(`/api/status${fresh ? '?fresh=1' : ''}`);
  $('#status-time').textContent = `Checked ${new Date(s.checkedAt).toLocaleTimeString()}`;
  $('#status-backends').replaceChildren(...Object.entries(s.backends).map(([k, b]) => h('div', { class: `card ${b.ok ? 'ok' : 'bad'}` }, h('div', { class: 'k' }, k), h('div', {}, b.ok ? 'Available' : 'Unavailable'), h('div', { class: 'muted' }, b.detail ?? ''))));
  $('#status-conn').replaceChildren(h('table', {},
    h('tr', {}, h('th', {}, 'Connector'), h('th', {}, 'Kind'), h('th', {}, 'Model'), h('th', {}, 'State'), h('th', {}, 'Detail')),
    Object.entries(s.connectors).map(([name, c]) => h('tr', {}, h('td', {}, name), h('td', {}, c.kind), h('td', {}, c.model),
      h('td', {}, h('span', { class: `pill ${c.ok ? 'ok' : 'bad'}` }, c.ok ? (c.loaded ? 'ready (loaded)' : 'ready') : 'unavailable')),
      h('td', { class: 'muted' }, c.detail ?? (c.kind === 'ollama' && !c.loaded ? 'loads on first use' : ''))))));
}
loaders.status = () => loadStatus(false);
$('#status-refresh').addEventListener('click', () => loadStatus(true).catch((e) => ($('#status-time').textContent = e.message)));

// ---- Schedule ----
async function loadSchedule() {
  const s = await api('/api/schedule');
  $('#schedule-state').replaceChildren(h('span', { class: `pill ${s.enabled ? 'ok' : 'bad'}` }, s.enabled ? 'Scheduler on' : 'Scheduler off (jobs only run on demand)'));
  const rows = s.jobs.map((j) => {
    const r = j.lastRun;
    const btn = h('button', { class: 'ghost' }, j.running ? 'Running…' : 'Run now');
    btn.disabled = j.running;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Running…';
      try { await api('/api/schedule/run', { method: 'POST', body: { name: j.name } }); } catch (e) { alert(e.message); }
      loadSchedule().catch(() => {});
    });
    return h('tr', {}, h('td', {}, j.name), h('td', {}, j.dailyAt ? `daily at ${j.dailyAt}` : `every ${j.everyMinutes} min`),
      h('td', {}, j.enabled === false ? 'disabled' : 'enabled'),
      h('td', {}, r ? `${when(r.ts)} ${r.ok === undefined ? '' : r.ok ? '✓' : '✗ exit ' + r.code}` : 'never'),
      h('td', { class: 'muted' }, r?.output ?? ''), h('td', {}, btn));
  });
  $('#schedule-jobs').replaceChildren(h('table', {}, h('tr', {}, ['Job', 'When', 'State', 'Last run', 'Output', ''].map((t) => h('th', {}, t))), rows.length ? rows : h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'No jobs configured'))));
  const q = Object.entries(s.queue ?? {});
  $('#schedule-queue').replaceChildren(h('table', {}, h('tr', {}, ['Backend', 'Running', 'Waiting', 'Limit'].map((t) => h('th', {}, t))),
    q.length ? q.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v.active), h('td', {}, v.queued), h('td', {}, v.limit))) : h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'No requests yet'))));
}
loaders.schedule = loadSchedule;

// ---- Config ----
function routeSummary(cfg) {
  return h('table', {}, h('tr', {}, h('th', {}, 'Route'), h('th', {}, 'Tries in order')),
    Object.entries(cfg.routes).map(([r, v]) => h('tr', {}, h('td', {}, r === cfg.default ? `${r} (default)` : r), h('td', {}, v.chain.map((c) => `${c} (${cfg.connectors[c]?.model})`).join(' → ')))));
}

loaders.config = async () => {
  const cfg = await loadConfig();
  $('#route-summary').replaceChildren(routeSummary(cfg));
  $('#cfg-routes').value = JSON.stringify({ connectors: cfg.connectors, routes: cfg.routes, default: cfg.default }, null, 2);
  $('#cfg-budgets').value = JSON.stringify(cfg.caps, null, 2);
  for (const id of ['save-routes', 'save-budgets']) $(`#${id}`).disabled = !cfg.editable;
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
    const cfg = await loadConfig();
    $('#route-summary').replaceChildren(routeSummary(cfg));
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = err.message;
  }
}
$('#save-routes').addEventListener('click', () => saveCfg('routes'));
$('#save-budgets').addEventListener('click', () => saveCfg('budgets'));

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
      out.append(ev.stream === 'stderr' || ev.type === 'stderr' ? h('span', { class: 'err' }, ev.text) : ev.text);
      out.scrollTop = out.scrollHeight;
    }
  }, termAbort.signal)
    .then((r) => out.append(h('span', { class: r.ok ? 'ok' : 'err' }, `\n[exit ${r.code}${r.timedOut ? ', timed out' : ''}${r.truncated ? ', output truncated' : ''} · ${secs(Date.now() - started)}]`)))
    .catch((err) => out.append(h('span', { class: 'err' }, `\n[${err.name === 'AbortError' ? 'stopped' : err.message}]`)))
    .finally(() => { termAbort = null; stopBtn.hidden = true; runBtn.disabled = false; });
}
$('#term-stop').addEventListener('click', () => termAbort?.abort());
$('#term-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const command = $('#term-cmd').value.trim();
  if (!command) return;
  runStreamed('/api/exec', { command, project: $('#term-project').value, cwd: $('#term-cwd').value.trim() || undefined }, $('#term-out'), $('#term-stop'), $('#term-run'));
});
loaders.terminal = loadProjects;

// ---- Projects & GitHub ----
function gitBtn(p, action, label, extra) {
  return h('button', { class: 'ghost', onclick: async (e) => {
    let message;
    if (action === 'sync') {
      message = prompt('Commit message for the public GitHub repo (this publishes):');
      if (!message?.trim()) return;
    }
    const btns = [...e.target.parentElement.querySelectorAll('button')];
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
      h('table', {}, h('tr', {}, h('th', {}, 'Commit'), h('th', {}, 'Message'), h('th', {}, 'When')), s.commits.map((c) => h('tr', {}, h('td', { class: 'mono' }, c.sha), h('td', {}, c.message), h('td', {}, when(c.date))))),
      s.runs.length ? h('table', {}, h('tr', {}, h('th', {}, 'CI run'), h('th', {}, 'Branch'), h('th', {}, 'Result')), s.runs.map((r) => h('tr', {}, h('td', {}, h('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.name)), h('td', {}, r.branch), h('td', {}, h('span', { class: `pill ${r.conclusion === 'success' ? 'ok' : r.conclusion ? 'bad' : 'warn'}` }, r.conclusion ?? r.status))))) : null);
    $('#gh-issues').replaceChildren(i.issues.length
      ? h('table', {}, i.issues.map((x) => h('tr', {}, h('td', {}, x.pullRequest ? 'PR' : 'Issue'), h('td', {}, h('a', { href: x.url, target: '_blank', rel: 'noopener' }, `#${x.number} ${x.title}`)), h('td', { class: 'muted' }, x.user))))
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
  $('#projects-table').replaceChildren(h('table', {}, h('tr', {}, ['Project', 'Folder', 'Actions'].map((t) => h('th', {}, t))),
    projects.map((p) => h('tr', {}, h('td', {}, h('strong', {}, p.name), h('div', { class: 'muted' }, p.description)), h('td', { class: 'mono' }, p.path),
      h('td', {}, h('span', { class: 'row' },
        p.canTest ? gitBtn(p, 'test', 'Run tests', 'tests') : null,
        p.git ? ['status', 'log', 'diff'].map((a) => gitBtn(p, a, a, `git ${a}`)) : null,
        p.canSync ? gitBtn(p, 'sync', 'Publish to GitHub', 'sync') : null))))));
  loadGithub();
};

// ---- Memory ----
let editing = null;
async function loadMemory() {
  const q = $('#mem-search').value.trim();
  const { notes } = await api(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#mem-list').replaceChildren(notes.length
    ? h('table', {}, h('tr', {}, ['Title', 'Note', 'Tags', ''].map((t) => h('th', {}, t))),
      notes.map((x) => h('tr', {}, h('td', {}, h('strong', {}, x.title)), h('td', {}, x.text), h('td', { class: 'muted' }, x.tags.join(', ')),
        h('td', {}, h('span', { class: 'row' },
          h('button', { class: 'ghost', onclick: () => { editing = x.id; $('#mem-title').value = x.title; $('#mem-text').value = x.text; $('#mem-tags').value = x.tags.join(', '); $('#mem-cancel').hidden = false; $('#mem-title').focus(); } }, 'Edit'),
          h('button', { class: 'ghost', onclick: async () => { if (!confirm(`Delete "${x.title}"? It moves to the memory trash.`)) return; await api(`/api/memory/${x.id}`, { method: 'DELETE' }); loadMemory(); } }, 'Delete'))))))
    : h('p', { class: 'muted' }, 'No notes.'));
}
function resetMemForm() {
  editing = null;
  $('#mem-form').reset();
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
    m.className = 'msg ok';
    m.textContent = 'Saved.';
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
    ? h('table', {}, h('tr', {}, ['Device', 'Access', 'Created', 'Last seen', ''].map((t) => h('th', {}, t))),
      devices.map((d) => h('tr', {}, h('td', {}, d.name), h('td', {}, d.scopes.join(', ')), h('td', {}, when(d.created)), h('td', {}, d.lastSeen ? when(d.lastSeen) : 'never'),
        h('td', {}, h('button', { class: 'ghost', onclick: async () => { if (!confirm(`Revoke "${d.name}"? Its token stops working immediately.`)) return; await api(`/api/devices/${d.id}`, { method: 'DELETE' }); loadDevices(); } }, 'Revoke')))))
    : h('p', { class: 'muted' }, 'No extra devices yet.'));
}
$('#dev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const m = $('#dev-msg');
  const scopes = [...document.querySelectorAll('#dev-form input[name=scope]:checked')].map((x) => x.value);
  try {
    const r = await api('/api/devices', { method: 'POST', body: { name: $('#dev-name').value, scopes } });
    m.className = 'msg ok';
    m.textContent = 'Created.';
    const box = $('#dev-token');
    box.hidden = false;
    box.replaceChildren(h('strong', {}, `Token for ${r.device.name} (shown once, copy it now):`), h('pre', { class: 'term' }, r.token));
    $('#dev-name').value = '';
    loadDevices();
  } catch (err) {
    m.className = 'msg bad';
    m.textContent = err.message;
  }
});
loaders.devices = loadDevices;

// ---- Boot ----
health();
setInterval(health, 30_000);
(async () => {
  await bootstrapToken();
  whoami = await api('/api/whoami').catch(() => null);
  await loadConfig().catch(() => {});
  if (config) applyFeatures();
  const start = location.hash.slice(1);
  show(loaders[start] || start === 'logan' ? start : 'chat');
})();
