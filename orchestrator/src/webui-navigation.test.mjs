import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the actual navigation/composer code with controlled service timing.
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const navigation = source.slice(source.indexOf('async function openConversation(id)'), source.indexOf("$('#new-chat').addEventListener"));
const composer = source.slice(source.indexOf('function syncComposer()'), source.indexOf('function renderChatTabs()'));
function fixture() {
  const nodes = new Map();
  const storage = new Map();
  const polls = [];
  const deferred = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', hidden: false, focus() {}, append() {}, querySelector() { return null; } });
    return nodes.get(selector);
  };
  const scope = {
    $: node, config: null, convId: 'original', chatNavigation: 0, chatLoading: false, reattachRunId: null,
    runs: new Set(), openChats: new Set(), unread: new Set(), composerDrafts: new Map(), pending: [], msgs: [],
    runFor: id => [...scope.runs].find(r => r.convId === id), runHere: () => [...scope.runs].find(r => r.viewing),
    localStorage: { setItem() {}, removeItem() {} },
    sessionStorage: { setItem(k, v) { storage.set(k, v); }, getItem: k => storage.get(k) },
    draftKey: () => `draft:${scope.convId}`, routeExists: () => true,
    syncProjectPicker() {}, syncModels() {}, renderAttachments() {}, renderChatTabs() {}, paintTitle() {},
    setHead(t) { node('#conv-title').textContent = t; }, renderThread() {}, scrollDown() {}, autosize() {}, toast() {},
    conv0Needs: () => false, messageEl() {}, secs: String,
    loadConversations: async () => {},
    setTimeout(fn) { polls.push(fn); },
    api(path) { return new Promise((resolve, reject) => deferred.set(path, { resolve, reject })); },
  };
  runInNewContext(`${composer}\n${navigation}\nthis.open = openConversation; this.sync = syncComposer;`, scope);
  return { scope, node, polls, resolve(id, conv = {}) { deferred.get(`/api/conversations/${id}`).resolve({ title: id, messages: [], ...conv }); }, reject(id) { deferred.get(`/api/conversations/${id}`).reject(new Error('offline')); } };
}
test('a slow previous chat cannot overwrite a newer selection', async () => {
  const f = fixture();
  const a = f.scope.open('a');
  const b = f.scope.open('b');
  f.resolve('b', { messages: [{ text: 'B reply' }] }); await b;
  f.resolve('a', { messages: [{ text: 'A reply' }] }); await a;
  assert.equal(f.scope.convId, 'b');
  assert.equal(f.node('#conv-title').textContent, 'b');
  assert.equal(f.scope.msgs[0].text, 'B reply');
});
test('New chat detaches existing work and is immediately usable', async () => {
  const f = fixture();
  const run = { convId: 'original', viewing: true };
  f.scope.runs.add(run);
  const opening = f.scope.open('slow');
  await f.scope.open(null);
  assert.equal(run.viewing, false);
  assert.equal(f.node('#send').disabled, false);
  f.resolve('slow'); await opening;
  assert.equal(f.scope.convId, null);
  assert.equal(f.node('#conv-title').textContent, 'New chat');
});
test('reattached run disables duplicate sends, leaving it enables a different chat', async () => {
  const f = fixture();
  const opening = f.scope.open('active');
  assert.equal(f.node('#send').disabled, true);
  f.resolve('active', { run: { status: 'running', started: 1, runId: 'run1' } }); await opening;
  assert.equal(f.node('#send').disabled, true);
  assert.equal(f.node('#stop').hidden, false);
  await f.scope.open(null);
  assert.equal(f.node('#send').disabled, false);
  assert.equal(f.node('#stop').hidden, true);
  await f.polls[0]();
  assert.equal(f.scope.reattachRunId, null);
});
test('draft text, model and attachments stay with their conversation', async () => {
  const f = fixture();
  f.node('#prompt').value = 'unfinished';
  f.node('#pin').value = 'local-main';
  f.scope.pending = [{ name: 'private.png' }];
  await f.scope.open(null);
  assert.equal(f.scope.pending.length, 0);
  assert.equal(f.node('#prompt').value, '');
  const back = f.scope.open('original'); f.resolve('original'); await back;
  assert.equal(f.node('#prompt').value, 'unfinished');
  assert.equal(f.node('#pin').value, 'local-main');
  assert.equal(f.scope.pending[0].name, 'private.png');
});
test('failed chat load releases composer state and a new chat remains usable', async () => {
  const f = fixture();
  const opening = f.scope.open('failed'); f.reject('failed'); await opening;
  assert.equal(f.scope.chatLoading, false);
  await f.scope.open(null);
  assert.equal(f.node('#send').disabled, false);
});
