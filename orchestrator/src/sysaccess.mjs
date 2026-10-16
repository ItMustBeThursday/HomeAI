// Whole-machine access for agent runs: every fixed drive, minus OneDrive (hard rule) and a few system-internal folders.
// A drive or folder that contains OneDrive is not granted itself; its other children are, so C:\ becomes C:\Windows,
// C:\Program Files, C:\Users\<you>\AppData, ... but never anything under OneDrive.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkFolder } from './grants.mjs';

const SKIP = new Set(['$recycle.bin', 'system volume information', 'recovery', 'config.msi', 'documents and settings', 'onedrivetemp']);
const MAX_DEPTH = 4;

const realListDirs = (p) => {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

// Pure enough to test: all file-system access is injected.
export function systemDirs({ drives = [], listDirs = realListDirs, check = checkFolder, skip = [] } = {}) {
  const skipSet = new Set([...SKIP, ...skip.map((s) => s.toLowerCase())]);
  const out = [];
  const visit = (p, depth) => {
    try {
      out.push(check(p));
      return;
    } catch (e) {
      if (!/contains OneDrive/i.test(String(e?.message)) || depth >= MAX_DEPTH) return;
    }
    for (const name of listDirs(p)) {
      if (skipSet.has(name.toLowerCase()) || /onedrive/i.test(name)) continue;
      visit(join(p, name), depth + 1);
    }
  };
  for (const d of drives) visit(d, 0);
  return [...new Set(out)];
}

const fixedDrives = () => 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((p) => {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
});

// config: { enabled, drives?: ["C:\\", ...], exclude?: ["folder name", ...] }. Cached briefly so each agent run is cheap.
export function createSystemAccess({ config = {}, drives = fixedDrives, listDirs = realListDirs, check = checkFolder, now = Date.now, ttlMs = 60_000 } = {}) {
  let cache = null;
  return {
    enabled: !!config.enabled,
    dirs() {
      if (!config.enabled) return [];
      if (cache && now() - cache.at < ttlMs) return cache.dirs;
      const list = Array.isArray(config.drives) && config.drives.length ? config.drives : drives();
      const dirs = systemDirs({ drives: list, listDirs, check, skip: config.exclude ?? [] });
      cache = { at: now(), dirs };
      return dirs;
    },
  };
}
