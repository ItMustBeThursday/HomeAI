// Encrypted credential store for account logins (GitHub and other connections).
// On Windows each secret is encrypted with DPAPI for the current user, so data/vault.json is useless on any other
// account or machine. Secrets are decrypted once at start-up, held in memory, and never returned by any endpoint.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const PS = (op) => `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser'))`;

// Runs a DPAPI operation in PowerShell. The secret travels over stdin (base64), never on a command line.
export function dpapi(op, { spawnImpl = spawn, shellBin = 'powershell.exe' } = {}) {
  return (input) =>
    new Promise((resolve, reject) => {
      let out = '';
      const child = spawnImpl(shellBin, ['-NoProfile', '-NonInteractive', '-Command', PS(op)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const timer = setTimeout(() => (child.kill(), reject(new Error('Credential encryption timed out'))), 15_000);
      child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
      child.on('error', (e) => (clearTimeout(timer), reject(e)));
      child.on('close', (code) => {
        clearTimeout(timer);
        code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error('Credential encryption failed'));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
}

export const dpapiCodec = (opts) => ({
  protect: async (plain) => dpapi('Protect', opts)(Buffer.from(plain, 'utf8').toString('base64')),
  unprotect: async (enc) => Buffer.from(await dpapi('Unprotect', opts)(enc), 'base64').toString('utf8'),
});

// codec: { protect(plain) -> string, unprotect(string) -> plain }. Tests pass a fake; production uses DPAPI.
export async function createVault({ file, codec = dpapiCodec(), now = Date.now } = {}) {
  let rows = {};
  if (file && existsSync(file)) rows = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const secrets = new Map();
  const broken = new Set();
  for (const [id, row] of Object.entries(rows)) {
    try {
      secrets.set(id, await codec.unprotect(row.enc));
    } catch {
      broken.add(id); // written by another Windows user or damaged; the connection shows as needing a new login
    }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(rows, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  return {
    get: (id) => secrets.get(id) ?? null,
    has: (id) => secrets.has(id),
    unreadable: (id) => broken.has(id),
    meta: (id) => (rows[id] ? { account: rows[id].account ?? null, connectedAt: rows[id].connectedAt, via: rows[id].via ?? null } : null),
    async set(id, secret, meta = {}) {
      if (typeof secret !== 'string' || !secret) throw new Error('secret must be a non-empty string');
      rows[id] = { enc: await codec.protect(secret), account: meta.account ?? null, via: meta.via ?? null, connectedAt: now() };
      secrets.set(id, secret);
      broken.delete(id);
      save();
    },
    remove(id) {
      const had = id in rows;
      delete rows[id];
      secrets.delete(id);
      broken.delete(id);
      if (had) save();
      return had;
    },
  };
}
