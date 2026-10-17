// HomeAI Discord bridge: a Discord bot that treats each allowed channel as ONE continuous chat with the local orchestrator
// (chat scope only). Messages are buffered and answered in batches by session.mjs; the model may choose to stay quiet.
// Config (never committed): D:\HomeAI\state\discord\config.json
//   { "discordToken": "...", "orchestratorToken": "<chat-scope device token>", "orchestratorUrl": "http://127.0.0.1:18850",
//     "channelIds": ["<channel id>"], "allowedUserIds": ["<Adam's Discord user id = owner>"], "route": "auto",
//     "openChat": true, "quietMs": 4000, "maxWaitMs": 20000, "maxBotStreak": 3, "reviewEvery": 10, "botName": "HomeAI" }
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { ChannelSession } from './session.mjs';

export const CONFIG_PATH = process.env.HOMEAI_DISCORD_CONFIG || 'D:/HomeAI/state/discord/config.json';
export const ROOM_PATH = process.env.HOMEAI_DISCORD_ROOMS || 'D:/HomeAI/state/discord/rooms.json';
export const SESSION_PATH = process.env.HOMEAI_DISCORD_SESSIONS || 'D:/HomeAI/state/discord/sessions.json';

export function splitMessage(text, max = 1900) {
  const out = []; let rest = String(text ?? '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max); if (cut < max / 2) cut = rest.lastIndexOf(' ', max); if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest); return out.length ? out : ['(no reply)'];
}

// Kill switch: only the configured owner (a real user, never a bot) saying the phrase stops the bridge. Matches anywhere in the message, case-insensitive.
export const KILL_PHRASE = 'vogon poetry';
export function isKill(msg, cfg) {
  if (!msg?.author || msg.author.bot) return false;
  if (!(Array.isArray(cfg.allowedUserIds) ? cfg.allowedUserIds : [cfg.allowedUserIds]).map(String).includes(String(msg.author.id))) return false;
  const phrase = String(cfg.killPhrase || KILL_PHRASE).toLowerCase();
  return String(msg.content ?? '').toLowerCase().replace(/\s+/g, ' ').includes(phrase);
}

const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);

// Turn a Discord message into a transcript entry, or null when it should be ignored entirely.
export function toEntry(msg, cfg, botId) {
  if (msg.author?.id === botId) return null;
  if (!list(cfg.channelIds).includes(String(msg.channelId))) return null;
  const isOwner = list(cfg.allowedUserIds).includes(String(msg.author?.id));
  const isBot = !!msg.author?.bot;
  const name = (msg.member?.displayName || msg.author?.globalName || msg.author?.username || 'someone');
  let text = String(msg.content ?? '').replace(new RegExp(`<@!?${botId}>`, 'g'), '@HomeAI').trim();
  if (msg.attachments?.size) text += `${text ? ' ' : ''}[${msg.attachments.size} attachment(s)]`;
  if (!text) return null;
  const ref = msg.mentions?.repliedUser;
  return {
    author: name, text, ts: msg.createdTimestamp ?? Date.now(), isBot, isOwner,
    mentionsBot: !!msg.mentions?.users?.has?.(botId), repliesToBot: !!ref && ref.id === botId,
  };
}

export async function ask(cfg, prompt, conversationId, fetchImpl = fetch) {
  const r = await fetchImpl(`${cfg.orchestratorUrl}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.orchestratorToken}` },
    body: JSON.stringify({ prompt, conversationId, taskType: cfg.route || 'auto', memory: false }), // memory:false is ignored by orchestrators that do not support it yet
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `orchestrator HTTP ${r.status}`);
  return { text: j.reply?.text ?? j.text ?? '', via: j.reply?.connector ?? j.connector, conversationId: j.conversationId ?? j.conversation?.id ?? conversationId };
}

const DOCS = join(dirname(fileURLToPath(import.meta.url)), 'docs');
// Read fresh each time so edits to the guide or persona apply on the next refresh, without a restart.
export function loadGuide(docs = DOCS) {
  const read = (f) => { try { return readFileSync(join(docs, f), 'utf8').trim(); } catch { return ''; } };
  return { guide: read('CHAT-GUIDE-CORE.txt') || undefined, persona: read('PERSONA.txt') };
}

function readSessions(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }
function writeSessions(path, data) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 1)); }

async function main() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const sessions = new Map();
  let killed = false;
  const kill = (where) => {
    if (killed) return; killed = true;
    console.log(`[${new Date().toISOString()}] KILL SWITCH from owner in ${where}: shutting down`);
    for (const x of sessions.values()) x.halt?.();
    setTimeout(() => process.exit(0), 1500).unref?.();
    client.destroy().catch(() => {}).finally(() => process.exit(0));
  };
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent] });
  const sessionFor = (channel) => {
    let s = sessions.get(channel.id);
    if (!s) {
      s = new ChannelSession({
        ask: (prompt, id) => ask(cfg, prompt, id),
        send: async (text) => { if (killed) return; for (const part of splitMessage(text)) await channel.send({ content: part, allowedMentions: { parse: [] } }); },
        typing: () => channel.sendTyping(),
        loadGuide: () => { const g = loadGuide(); return { guide: g.guide ?? undefined, persona: g.persona }; },
        loadRoom: () => readSessions(ROOM_PATH)[channel.id],
        saveRoom: (st) => { const d = readSessions(ROOM_PATH); d[channel.id] = st; writeSessions(ROOM_PATH, d); },
        loadId: () => readSessions(SESSION_PATH)[channel.id],
        saveId: (id) => { const d = readSessions(SESSION_PATH); if (id) d[channel.id] = id; else delete d[channel.id]; writeSessions(SESSION_PATH, d); },
        log: (m) => console.log(`[${new Date().toISOString()}] #${channel.id} ${m}`),
        quietMs: cfg.quietMs ?? 4000, maxWaitMs: cfg.maxWaitMs ?? 20000, maxBotStreak: cfg.maxBotStreak ?? 3, openChat: cfg.openChat !== false,
        reviewEvery: cfg.reviewEvery ?? 10, botName: cfg.botName || 'HomeAI',
      });
      sessions.set(channel.id, s);
    }
    return s;
  };
  client.once(Events.ClientReady, (c) => console.log(`discord bridge online as ${c.user.tag}`));
  client.on(Events.MessageCreate, (msg) => {
    if (killed) return;
    if (isKill(msg, cfg)) { kill(msg.channelId); return; }
    const entry = toEntry(msg, cfg, client.user.id);
    if (entry) sessionFor(msg.channel).hear(entry);
  });
  await client.login(cfg.discordToken);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
