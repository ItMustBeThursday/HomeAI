import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVault } from './vault.mjs';
import { createConnections } from './connections.mjs';
import { createGithub } from './github.mjs';

const codec = { protect: async (s) => s, unprotect: async (s) => s };
const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });

async function setup(fetchImpl, config = {}) {
  const vault = await createVault({ codec });
  return { vault, c: createConnections({ vault, config, fetchImpl }) };
}

test('connect validates against GitHub, stores the login, and list never exposes the secret', async () => {
  const calls = [];
  const { c } = await setup(async (url, init) => (calls.push([url, init.headers.authorization]), reply(200, { login: 'adam' })));
  assert.deepEqual(await c.connect('github', ' ghp_abc '), { id: 'github', account: 'adam' });
  assert.deepEqual(calls[0], ['https://api.github.com/user', 'Bearer ghp_abc']);
  assert.equal(c.getSecret('github'), 'ghp_abc');
  const row = c.list().find((x) => x.id === 'github');
  assert.equal(row.connected, true);
  assert.equal(row.account, 'adam');
  assert.ok(!JSON.stringify(c.list()).includes('ghp_abc'));
});

test('a rejected token is not saved and not echoed', async () => {
  const { c } = await setup(async () => reply(401, { message: 'Bad credentials' }));
  await assert.rejects(() => c.connect('github', 'ghp_wrong'), (e) => /rejected/.test(e.message) && !e.message.includes('ghp_wrong'));
  assert.equal(c.getSecret('github'), null);
});

test('disconnect removes the login; unknown ids fail', async () => {
  const { c } = await setup(async () => reply(200, { login: 'a' }));
  await c.connect('github', 'tok');
  assert.deepEqual(c.disconnect('github'), { id: 'github', removed: true });
  assert.equal(c.getSecret('github'), null);
  assert.throws(() => c.disconnect('nope'), /not found/);
});

test('declared providers are data only and validated', async () => {
  const seen = [];
  const { c } = await setup(async (url, init) => (seen.push([url, init.headers['X-Api-Key']]), reply(200, { user: { name: 'Pat' } })), {
    providers: { notes: { name: 'Notes', testUrl: 'https://notes.example/api/me', auth: 'X-Api-Key', accountField: 'user.name' } },
  });
  assert.equal((await c.connect('notes', 'k1')).account, 'Pat');
  assert.deepEqual(seen[0], ['https://notes.example/api/me', 'k1']);
  assert.throws(() => createConnections({ vault: {}, config: { providers: { bad: { testUrl: 'http://insecure.example' } } } }), /https/);
  assert.throws(() => createConnections({ vault: {}, config: { providers: { github: { testUrl: 'https://x.example' } } } }), /Bad connection provider/);
});

test('device flow: pending, then connected', async () => {
  const answers = [
    reply(200, { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
    reply(200, { error: 'authorization_pending' }),
    reply(200, { access_token: 'gho_tok' }),
    reply(200, { login: 'adam' }),
  ];
  const { c } = await setup(async () => answers.shift(), { github: { clientId: 'Iv1.abc' } });
  assert.equal(c.list()[0].deviceFlow, true);
  assert.equal((await c.deviceStart()).userCode, 'ABCD-1234');
  assert.equal((await c.devicePoll()).status, 'pending');
  assert.deepEqual(await c.devicePoll(), { status: 'connected', account: 'adam' });
  assert.equal(c.getSecret('github'), 'gho_tok');
});

test('device flow needs a client id', async () => {
  const { c } = await setup(async () => reply(200, {}));
  await assert.rejects(() => c.deviceStart(), /clientId/);
  await assert.rejects(() => c.devicePoll(), /No device login/);
});

test('the GitHub client prefers the saved login over Git Credential Manager', async () => {
  const headers = [];
  const gh = createGithub({
    repo: 'o/r', tokenSource: async () => 'saved_tok',
    spawnImpl: () => { throw new Error('GCM must not be used'); },
    fetchImpl: async (url, init) => (headers.push(init.headers.authorization), reply(200, [])),
  });
  await gh.issues();
  assert.deepEqual(headers, ['Bearer saved_tok']);
});
