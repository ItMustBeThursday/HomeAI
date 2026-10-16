// Live connector check using the same runner, stdin transport and models as the service.
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../src/connectors/run.mjs';

export async function smoke({ names, config, run, output = console.log }) {
  let failed = false;
  for (const name of names) {
    const kind = { ollama: 'ollama', claude: 'claude-cli', codex: 'codex-cli' }[name];
    const found = Object.entries(config.connectors).find(([, c]) => c.kind === kind);
    try {
      if (!found) throw new Error(`No configured connector for ${name}`);
      const [connector, entry] = found;
      const result = await run({ ...entry, connector, tools: [], maxTurns: 1 }, { prompt: 'Reply with exactly: pong' });
      output(name, JSON.stringify(result));
      if (!result.ok || result.text.trim() !== 'pong') failed = true;
    } catch (err) {
      output(name, 'FAILED', err.message);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const env = process.env;
  const config = JSON.parse(readFileSync(env.HOMEAI_ORCH_ROUTES ?? join(root, 'config', 'routes.json'), 'utf8'));
  const cwd = join(env.HOMEAI_ORCH_DATA ?? join(root, 'data'), 'scratch');
  mkdirSync(cwd, { recursive: true });
  const run = createRunner({
    cwd,
    claudeBin: env.HOMEAI_CLAUDE_BIN ?? 'claude',
    codexScript: env.HOMEAI_CODEX_SCRIPT ?? 'D:/HomeAI/runtime/codex/node_modules/@openai/codex/bin/codex.js',
    ollamaUrl: env.HOMEAI_OLLAMA_URL,
  });
  process.exitCode = await smoke({ names: process.argv.slice(2).length ? process.argv.slice(2) : ['ollama'], config, run });
}
