// Standing folder permissions for agent runs, beyond the registered project folders.
// "Always allow" saves a folder here; "allow once" lives only on the job that asked (see jobs.mjs).
// Hard rule: OneDrive is never granted, and neither is any folder that contains a OneDrive folder.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, relative, parse } from 'node:path';
import { randomUUID } from 'node:crypto';

const ONEDRIVE = /onedrive/i;
const within = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// Known OneDrive roots (including Known Folder Move) from the environment; these are off limits.
export const oneDriveRoots = (env = process.env) => [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter(Boolean).map((p) => resolve(p));

// Returns the normalized absolute path or throws a plain-English error.
export function checkFolder(input, { blocked = oneDriveRoots(), exists = (p) => existsSync(p) && statSync(p).isDirectory() } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path must be a non-empty string');
  const p = resolve(input.trim().replace(/^"|"$/g, ''));
  if (!isAbsolute(input.trim().replace(/^"|"$/g, ''))) throw new Error('path must be absolute, like D:\\Games');
  if (ONEDRIVE.test(p)) throw new Error('OneDrive is off limits');
  for (const b of blocked) {
    if (within(b, p) || within(p, b)) throw new Error(`That folder is or contains OneDrive (${b}), which is off limits`);
  }
  if (!exists(p)) throw new Error(`Folder does not exist: ${p}`);
  return parse(p).root === p ? p : p.replace(/[\\/]+$/, '');
}

export function createGrants({ file, now = Date.now, newId = randomUUID, check = checkFolder } = {}) {
  let folders = [];
  if (file && existsSync(file)) {
    try {
      folders = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).folders ?? [];
    } catch {
      try { renameSync(file, `${file}.corrupt-${now()}`); } catch {}
    }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ folders }, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  return {
    list: () => folders.map((f) => ({ ...f })),
    // write=false folders are only offered to read-only runs (planning).
    add({ path, write = true, note } = {}) {
      const p = check(path);
      const have = folders.find((f) => same(f.path, p));
      if (have) {
        have.write = have.write || !!write;
        save();
        return { ...have };
      }
      const f = { id: newId(), path: p, write: !!write, note: typeof note === 'string' ? note.slice(0, 200) : undefined, added: now() };
      folders.push(f);
      save();
      return { ...f };
    },
    remove(id) {
      const before = folders.length;
      folders = folders.filter((f) => f.id !== id);
      if (folders.length === before) throw new Error('Grant not found');
      save();
    },
    // Folder paths to hand to an agent run. Re-checked each time so a folder that later turns out to be unsafe is dropped.
    dirs({ readOnly = false } = {}) {
      const out = [];
      for (const f of folders) {
        if (readOnly === false && !f.write) continue;
        try { out.push(check(f.path)); } catch {}
      }
      return out;
    },
    covers: (path) => folders.some((f) => within(f.path, resolve(path))),
  };
}
