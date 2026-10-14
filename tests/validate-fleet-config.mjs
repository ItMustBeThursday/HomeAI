import fs from 'node:fs';
import {t as schema} from '../research/package-check/package/dist/zod-schema-B-D6bTAy.mjs';
const config=JSON.parse(fs.readFileSync(new URL('./artifacts/fleet-config.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const checked=schema.safeParse(config);if(!checked.success)throw Error(JSON.stringify(checked.error.issues));
console.log('PASS: fleet configuration satisfies actual pinned OpenClaw core schema.');
