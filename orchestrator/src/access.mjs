// Who may call the API. One admin token (full control) plus per-device tokens with limited scope.
//   read  : GET dashboards (usage, status, history, schedule, config, projects, memory)
//   chat  : read + send tasks and chat (never agent/shell routes)
//   logan : the Logan device feed only (Phase 3)
//   admin : everything, including shell, projects, git, config edits, devices
// Device tokens are stored only as SHA-256 hashes; the plain token is shown once, when created.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const SCOPES = ['read', 'chat', 'logan', 'admin'];
const IMPLIES = { admin: ['read', 'chat', 'logan', 'admin'], chat: ['read', 'chat'], read: ['read'], logan: ['logan'] };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const bearer = (header) => String(header ?? '').replace(/^Bearer\s+/i, '').trim();
const newToken = (prefix) => `${prefix}_${randomBytes(32).toString('base64url')}`;

// The admin token lives in a file next to the data so the WebUI, MCP server and scripts on this PC can read it.
export function loadOrCreateToken(file) {
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 24) return t;
  }
  mkdirSync(dirname(file), { recursive: true });
  const t = newToken('hai');
  writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

export function createAuth({ adminToken, devicesFile, now = Date.now, newId = randomUUID } = {}) {
  if (typeof adminToken !== 'string' || adminToken.length < 16) throw new Error('adminToken must be at least 16 characters');
  const admin = Buffer.from(adminToken);
  let devices = [];
  if (devicesFile && existsSync(devicesFile)) devices = JSON.parse(readFileSync(devicesFile, 'utf8').replace(/^\uFEFF/, ''));
  const save = () => {
    if (!devicesFile) return;
    mkdirSync(dirname(devicesFile), { recursive: true });
    writeFileSync(`${devicesFile}.tmp`, JSON.stringify(devices, null, 2));
    renameSync(`${devicesFile}.tmp`, devicesFile);
  };
  const pub = ({ hash, ...d }) => d;

  return {
    // → { id, name, scopes: Set } or null
    identify(authorization) {
      const got = bearer(authorization);
      if (!got) return null;
      const buf = Buffer.from(got);
      if (buf.length === admin.length && timingSafeEqual(buf, admin)) return { id: 'admin', name: 'admin', scopes: new Set(IMPLIES.admin) };
      const h = sha(got);
      const d = devices.find((x) => x.hash === h);
      if (!d) return null;
      d.lastSeen = now();
      return { id: d.id, name: d.name, scopes: new Set(d.scopes.flatMap((s) => IMPLIES[s] ?? [])) };
    },
    addDevice({ name, scopes }) {
      if (typeof name !== 'string' || !name.trim()) throw new Error('name must be a non-empty string');
      if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !SCOPES.includes(s))) throw new Error(`scopes must be a non-empty subset of ${SCOPES.join(', ')}`);
      const token = newToken('hd');
      const device = { id: newId(), name: name.trim().slice(0, 60), scopes: [...new Set(scopes)], hash: sha(token), created: now(), lastSeen: null };
      devices.push(device);
      save();
      return { device: pub(device), token };
    },
    removeDevice(id) {
      const before = devices.length;
      devices = devices.filter((d) => d.id !== id);
      if (devices.length === before) throw new Error('Device not found');
      save();
    },
    listDevices: () => devices.map(pub),
    // Persist lastSeen occasionally; cheap enough to call on a timer.
    flush: save,
  };
}

export const can = (identity, scope) => !!identity && identity.scopes.has(scope);
