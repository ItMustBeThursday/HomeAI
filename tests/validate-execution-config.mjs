import fs from 'node:fs';
import {createRequire} from 'node:module';
import {t as schema} from '../research/package-check/package/dist/zod-schema-B-D6bTAy.mjs';
const config=JSON.parse(fs.readFileSync(new URL('./artifacts/execution-config.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const checked=schema.safeParse(config);if(!checked.success)throw Error(JSON.stringify(checked.error.issues));
const require=createRequire(new URL('../research/openclaw-runtime-check/package.json',import.meta.url));const Ajv=require('ajv');
const manifest=JSON.parse(fs.readFileSync(new URL('../home-ai-kit/execution-plugin/openclaw.plugin.json',import.meta.url),'utf8'));
const validate=new Ajv({strict:false}).compile(manifest.configSchema);if(!validate(config.plugins.entries['homeai-execution'].config))throw Error(JSON.stringify(validate.errors));
console.log('PASS: execution configuration satisfies actual pinned OpenClaw core and plugin schemas.');
