// Account connections ("plugins"): each provider says how to check a login, and the vault keeps the secret.
//   github  : built in. Connect with a personal access token, or with GitHub's device flow when
//             config/connections.json has github.clientId (an OAuth app with Device Flow enabled).
//   others  : declared in config/connections.json under "providers" - a service that accepts a token on an HTTPS
//             endpoint. No code is loaded from config; a provider is just data.
//             { "id": { "name", "description", "testUrl", "auth": "bearer"|"token"|"<Header-Name>", "accountField" } }
// Secrets never leave this module except through getSecret(), which only in-process code (e.g. the GitHub client) uses.
const ID = /^[a-z][a-z0-9-]{0,30}$/;
const GITHUB = { id: 'github', name: 'GitHub', description: 'Issues, pull requests and CI for the HoopyFrood repo; later, anything your login can reach.', builtin: true };

function headerFor(auth, secret) {
  if (auth === 'bearer' || !auth) return { authorization: `Bearer ${secret}` };
  if (auth === 'token') return { authorization: `token ${secret}` };
  if (/^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(auth)) return { [auth]: secret };
  throw new Error('provider auth must be bearer, token or a header name');
}

export function createConnections({ vault, config = {}, fetchImpl = fetch } = {}) {
  const custom = {};
  for (const [id, p] of Object.entries(config.providers ?? {})) {
    if (!ID.test(id) || id === 'github') throw new Error(`Bad connection provider id: ${id}`);
    if (!/^https:\/\//.test(p.testUrl ?? '')) throw new Error(`Provider ${id}: testUrl must be https`);
    headerFor(p.auth, 'x');
    custom[id] = { id, name: p.name ?? id, description: p.description ?? '', testUrl: p.testUrl, auth: p.auth ?? 'bearer', accountField: p.accountField };
  }
  const clientId = config.github?.clientId || '';
  const scope = config.github?.scope || 'repo workflow read:user';
  const providers = () => [GITHUB, ...Object.values(custom)];
  const find = (id) => {
    const p = providers().find((x) => x.id === id);
    if (!p) throw new Error(`Connection not found: ${id}`);
    return p;
  };

  async function fetchJson(url, init) {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const data = await res.json().catch(() => null);
    return { res, data };
  }

  // Returns the account name when the secret works; throws a message that never contains the secret.
  async function check(p, secret) {
    if (p.id === 'github') {
      const { res, data } = await fetchJson('https://api.github.com/user', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'homeai-orchestrator', ...headerFor('bearer', secret) } });
      if (!res.ok) throw new Error(res.status === 401 ? 'GitHub rejected that token' : `GitHub check failed (${res.status})`);
      return data?.login ?? 'unknown';
    }
    const { res, data } = await fetchJson(p.testUrl, { headers: { accept: 'application/json', 'user-agent': 'homeai-orchestrator', ...headerFor(p.auth, secret) } });
    if (!res.ok) throw new Error(`${p.name} rejected that credential (${res.status})`);
    const acct = p.accountField ? String(p.accountField).split('.').reduce((o, k) => o?.[k], data) : null;
    return typeof acct === 'string' ? acct : 'connected';
  }

  let pendingDevice = null; // one device-flow login at a time; the device code stays server-side

  return {
    list() {
      return providers().map((p) => {
        const m = vault.meta(p.id);
        return {
          id: p.id, name: p.name, description: p.description, builtin: !!p.builtin,
          connected: vault.has(p.id), needsLogin: vault.unreadable(p.id),
          account: m?.account ?? null, connectedAt: m?.connectedAt ?? null, via: m?.via ?? null,
          deviceFlow: p.id === 'github' && !!clientId,
        };
      });
    },
    async connect(id, secret) {
      const p = find(id);
      if (typeof secret !== 'string' || !secret.trim()) throw new Error('Paste a token first');
      const s = secret.trim();
      const account = await check(p, s);
      await vault.set(id, s, { account, via: 'token' });
      return { id, account };
    },
    disconnect(id) {
      find(id);
      return { id, removed: vault.remove(id) };
    },
    getSecret: (id) => vault.get(id),

    // GitHub device flow: start() returns the code to type at github.com/login/device; poll() finishes the login.
    async deviceStart() {
      if (!clientId) throw new Error('Device login needs github.clientId in config/connections.json; paste a token instead');
      const { res, data } = await fetchJson('https://github.com/login/device/code', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'homeai-orchestrator' }, body: JSON.stringify({ client_id: clientId, scope }),
      });
      if (!res.ok || !data?.device_code) throw new Error(`GitHub device login failed: ${data?.error_description ?? res.status}`);
      pendingDevice = { code: data.device_code, expires: Date.now() + data.expires_in * 1000 };
      return { userCode: data.user_code, verificationUri: data.verification_uri, expiresIn: data.expires_in, interval: data.interval ?? 5 };
    },
    async devicePoll() {
      if (!pendingDevice || Date.now() > pendingDevice.expires) {
        pendingDevice = null;
        throw new Error('No device login in progress; start again');
      }
      const { data } = await fetchJson('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'homeai-orchestrator' },
        body: JSON.stringify({ client_id: clientId, device_code: pendingDevice.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      if (data?.access_token) {
        pendingDevice = null;
        const account = await check(GITHUB, data.access_token);
        await vault.set('github', data.access_token, { account, via: 'device' });
        return { status: 'connected', account };
      }
      if (data?.error === 'authorization_pending' || data?.error === 'slow_down') return { status: 'pending', slowDown: data.error === 'slow_down' };
      pendingDevice = null;
      throw new Error(data?.error === 'access_denied' ? 'Login was cancelled on GitHub' : data?.error === 'expired_token' ? 'The code expired; start again' : `GitHub device login failed: ${data?.error ?? 'unknown'}`);
    },
  };
}
