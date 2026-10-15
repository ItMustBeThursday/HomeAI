import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const base=fs.mkdtempSync(path.join(os.tmpdir(),'homeai-backup-check-')),root=path.join(base,'homeai'),backupRoot=path.join(base,'backups');
fs.mkdirSync(root);fs.mkdirSync(backupRoot);
fs.writeFileSync(path.join(root,'homeai.json'),JSON.stringify({owner:'home-ai-kit-v1',root,backupRoot}));
fs.mkdirSync(path.join(root,'projects','app'),{recursive:true});
fs.writeFileSync(path.join(root,'projects','app','code.mjs'),'export const x = 1;');
fs.mkdirSync(path.join(root,'state','openclaw','cache','control-ui-assets'),{recursive:true});
fs.writeFileSync(path.join(root,'state','openclaw','cache','control-ui-assets','generated.txt'),'excluded');
fs.writeFileSync(path.join(root,'state','openclaw','keep.txt'),'preserved state');
const script=fileURLToPath(new URL('../home-ai-kit/backup-snapshot.mjs',import.meta.url));
function snapshot(suffix){const dest=path.join(backupRoot,'20261015-130000-'+suffix);fs.mkdirSync(dest);const result=spawnSync(process.execPath,[script,root,dest],{encoding:'utf8'});return {dest,result};}
const {dest,result}=snapshot('aabbccdd');assert.equal(result.status,0,result.stderr);
const manifest=JSON.parse(fs.readFileSync(path.join(dest,'backup-manifest.json'),'utf8'));
assert.equal(manifest.verified,true);assert.equal(manifest.files.length,3);
for(const entry of manifest.files){const saved=fs.readFileSync(path.join(dest,...entry.path.split('\\')));assert.equal(crypto.createHash('sha256').update(saved).digest('hex').toUpperCase(),entry.sha256);}
assert(manifest.excluded.some(e=>e.path==='state\\openclaw\\cache\\control-ui-assets'));
assert(result.stdout.includes('verified files'),'Backup is silent');
const link=path.join(root,'projects','unexpected-link');fs.symlinkSync(path.join(root,'state'),link,process.platform==='win32'?'junction':'dir');
const failed=snapshot('aabbccee');assert.notEqual(failed.result.status,0);assert(!fs.existsSync(path.join(failed.dest,'backup-manifest.json')),'Failed snapshot was marked complete');
console.log('PASS: copied hashes and restore-compatible manifest, exact cache exclusion, visible progress, link refusal and no completion manifest on failure. Fixtures retained at '+base);
