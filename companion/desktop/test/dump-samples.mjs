// Captures trimmed real payload shapes into docs/samples.json for UI implementers.
import fs from 'node:fs';
import { GatewayClient } from '../src/core/gateway-client.mjs';

const idPath = new URL('./.smoke-identity.json', import.meta.url);
let conn = { url: process.argv[2] ?? 'ws://127.0.0.1:18795', gatewayToken: process.env.HOMEAI_GW_TOKEN };
const store = {
  loadIdentity: async () => JSON.parse(fs.readFileSync(idPath, 'utf8')),
  saveIdentity: async () => {},
  loadConnection: async () => conn,
  saveConnection: async (c) => { conn = { ...conn, ...c }; },
};
const trim = (v, depth = 0) => {
  if (typeof v === 'string') return v.length > 160 ? v.slice(0, 160) + '…' : v;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => trim(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, depth > 6 ? '…' : trim(x, depth + 1)]));
  return v;
};
const gw = new GatewayClient({ store, client: { id: 'webchat', version: '0.1.0', platform: 'windows', mode: 'ui', deviceFamily: 'desktop' } });
gw.on('status', async ({ state }) => {
  if (state !== 'connected') return;
  const sessions = await gw.listSessions({ limit: 3 });
  const key = sessions.sessions.find((s) => /companion/.test(s.key))?.key ?? sessions.sessions[0].key;
  const history = await gw.history(key, 4);
  const out = { sessionsList: trim(sessions), chatHistory: trim(history), models: trim(await gw.listModels()), agents: trim(await gw.listAgents()) };
  fs.writeFileSync(new URL('../../docs/samples.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log('wrote samples; history keys:', Object.keys(history), 'session row keys:', Object.keys(sessions.sessions[0]).join(','));
  gw.stop();
});
await gw.start();
