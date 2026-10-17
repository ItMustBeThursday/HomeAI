// Verified snapshots; no links, private sessions, OneDrive access, or automatic deletion.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

function safePath(value) {
  const full = path.resolve(value);
  if (full.split(/[\\/]/).some(p => /^OneDrive($| - )/i.test(p))) throw Error('OneDrive paths are refused');
  for (const name of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    if (!process.env[name]) continue;
    const base = path.resolve(process.env[name]).toLowerCase();
    if (full.toLowerCase() === base || full.toLowerCase().startsWith(base + path.sep)) throw Error('OneDrive paths are refused');
  }
  for (let cursor = full;; cursor = path.dirname(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('Backup refuses links'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (path.dirname(cursor) === cursor) break;
  }
  return full;
}
const inside = (base, target) => {
  const relative = path.relative(base.toLowerCase(), target.toLowerCase());
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const buffer = Buffer.allocUnsafe(1024 * 1024);
const hash = file => {
  const digest = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try { let count; while ((count = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, count)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
};

export function backupData(rootArg, destArg) {
  const root = safePath(rootArg), dest = safePath(destArg);
  if (inside(root, dest) || inside(dest, root)) throw Error('Backup destination and source must not overlap');
  let found = false;
  for (const name of ['data', 'config']) {
    const entry = safePath(path.join(root, name));
    try { if (!fs.statSync(entry).isDirectory()) throw Error('Backup source must be a directory'); found = true; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (!found) throw Error('No data or config source directory exists');
  const target = path.join(dest, new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID());
  fs.mkdirSync(target, { recursive: true });
  const files = [];
  function visit(relative) {
    // Exclude before accessing an entry, including links with excluded names.
    if (relative.split(path.sep).some(p => /^(private|scratch|OneDrive(?: - .*)?)$/i.test(p)) || /\.log$/i.test(relative)) return;
    const source = safePath(path.join(root, relative)), output = path.join(target, relative);
    let stat;
    try { stat = fs.lstatSync(source); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (stat.isDirectory()) {
      fs.mkdirSync(output, { recursive: true });
      for (const entry of fs.readdirSync(source)) visit(path.join(relative, entry));
    } else if (stat.isFile()) {
      const sha256 = hash(source);
      fs.copyFileSync(source, output, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(output, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const after = fs.statSync(source);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || hash(output) !== sha256 || hash(source) !== sha256) throw Error('Source changed or snapshot verification failed');
      files.push({ path: relative, sha256 });
    } else throw Error('Backup refuses nonregular entries');
  }
  for (const name of ['data', 'config']) visit(name);
  const manifest = { verified: true, createdAt: new Date().toISOString(), excluded: ['private', 'scratch', '*.log'], files };
  const pending = path.join(target, 'manifest.pending');
  fs.writeFileSync(pending, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  const fd = fs.openSync(pending, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(pending, path.join(target, 'manifest.json'));
  return { target, files: files.length, verified: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2] || !process.argv[3]) throw Error('Source and destination required');
    console.log(JSON.stringify(backupData(process.argv[2], process.argv[3])));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
