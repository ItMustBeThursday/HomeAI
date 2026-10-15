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

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending) return;
  const text = $('#prompt').value.trim();
  if (!text) return;
  sending = true;
  $('#send').disabled = true;
  addMessage({ role: 'user', text });
  $('#prompt').value = '';
  const started = Date.now();
  const tick = setInterval(() => ($('#busy').textContent = `Waiting for a model… ${secs(Date.now() - started)}`), 250);
  try {
    const r = await api('/api/chat', { method: 'POST', body: { conversationId: convId ?? undefined, prompt: text, taskType: $('#route').value, connector: $('#pin').value || undefined } });
    const isNew = !convId;
    convId = r.conversation.id;
    if (isNew) $('#conv-title').textContent = r.conversation.title;
    $('#rename-chat').hidden = $('#archive-chat').hidden = false;
    addMessage({ role: 'assistant', ...r.reply });
    loadConversations();
  } catch (err) {
    addMessage({ role: 'assistant', error: err.message });
    $('#prompt').value = text;
  } finally {
    clearInterval(tick);
    $('#busy').textContent = '';
    $('#send').disabled = false;
    sending = false;
  }
});
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit();
});

loaders.chat = async () => {
  await loadConfig();
  await loadConversations();
};

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

// ---- Boot ----
health();
setInterval(health, 30_000);
const start = location.hash.slice(1);
show(loaders[start] || start === 'logan' ? start : 'chat');
