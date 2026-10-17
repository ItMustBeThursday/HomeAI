// Manual live check (not part of the offline suite): node test/live-smoke.mjs <url>
// Uses HOMEAI_GW_TOKEN; identity persisted to test/.smoke-identity.json so approval sticks.
import fs from 'node:fs';
import { GatewayClient, newSessionKey } from '../src/core/gateway-client.mjs';

const idPath = new URL('./.smoke-identity.json', import.meta.url);
let conn = { url: process.argv[2] ?? 'ws://127.0.0.1:18795', gatewayToken: process.env.HOMEAI_GW_TOKEN };
const store = {
  loadIdentity: async () => (fs.existsSync(idPath) ? JSON.parse(fs.readFileSync(idPath, 'utf8')) : null),
  saveIdentity: async (id) => fs.writeFileSync(idPath, JSON.stringify(id)),
  loadConnection: async () => conn,
  saveConnection: async (c) => { conn = c ? { ...conn, ...c } : null; },
};
const gw = new GatewayClient({ store, client: { id: 'webchat', version: '0.1.0', platform: 'windows', mode: 'ui', deviceFamily: 'desktop' } });
gw.on('status', async ({ state, detail }) => {
  console.log('STATUS', state, JSON.stringify(detail));
  if (state === 'pairing') { console.log('APPROVE:', detail.approveCommand); gw.stop(); }
  if (state === 'auth-error' || state === 'error') gw.stop();
  if (state !== 'connected') return;
  const s = await gw.listSessions({ limit: 2 });
  console.log('SESSIONS ok', s.sessions?.length);
  const m = await gw.listModels();
  console.log('MODELS', JSON.stringify(m).slice(0, 300));
  const a = await gw.listAgents();
  console.log('AGENTS', JSON.stringify(a).slice(0, 300));
  if (process.argv[3] === 'chat') {
    const key = newSessionKey();
    gw.on('event', (ev, p) => {
      if (ev !== 'chat' || p.sessionKey !== key) return;
      console.log('CHAT', p.state, p.deltaText ?? '');
      if (['final', 'error', 'aborted'].includes(p.state)) gw.stop();
    });
    console.log('SEND', JSON.stringify(await gw.sendMessage({ sessionKey: key, message: 'Smoke test. Reply with exactly: ok' })));
  } else gw.stop();
});
await gw.start();
