// Checks the auto-route classifier against the real local model: node scripts/auto-eval.mjs [connector]
// A connector argument forces the check onto that model. Prints each decision and its time; exits 1 on any miss.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../src/connectors/run.mjs';
import { createAutoRouter } from '../src/autoroute.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'config', 'routes.json'), 'utf8').replace(/^﻿/, ''));
if (process.argv[2]) config.auto.check = process.argv[2];
const decide = createAutoRouter({ getConfig: () => config, run: createRunner({ ollamaUrl: process.env.HOMEAI_OLLAMA_URL, cwd: root }) });

const cases = [
  ['What is the capital of Australia?', 'chat'],
  ['Explain how a heat pump works', 'chat'],
  ['Write a short birthday message for my mum', 'chat'],
  ['What are good shows for a 10 year old?', 'chat'],
  ['Is it better to use tabs or spaces?', 'chat'],
  ['Run the tests and tell me what fails', 'act'],
  ['How much free disk space do I have?', 'act'],
  ['Check whether Ollama is running', 'act'],
  ['Add a README to the workspace project', 'act'],
  ['What is the weather in Boston today?', 'act'],
  ['Commit and push the changes', 'act'],
  ['What files are in the workspace?', 'act'],
  ['Move every old project into an archive folder and delete the duplicates', 'plan'],
  ['Delete all the log files in the workspace', 'plan'],
  ['Tidy up the projects folder', 'plan'],
  ['Can you rename notes.md to todo.md', 'act'],
  ['Why did my last test run fail?', 'act'],
  ['Summarise this: the meeting moved to Tuesday and Bob will bring snacks', 'chat'],
  ['thanks!', 'chat'],
  ['git log -5', 'act'],
];
let bad = 0;
for (const [prompt, want] of cases) {
  const d = await decide({ prompt });
  const ok = d.kind === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'MISS'} ${String(d.ms).padStart(5)}ms ${d.via.padEnd(8)} ${d.kind.padEnd(4)} (want ${want})  ${prompt}`);
}
console.log(bad ? `${bad} misrouted` : 'all routed as expected');
process.exit(bad ? 1 : 0);
