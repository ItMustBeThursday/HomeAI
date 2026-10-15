/**
 * Explicit CLI only; import has no execution effects.
 * node run-kit.mjs validate|run|test|build|serve relative-manifest.json [--allow-build] [--allow-serve]
 *   [--tool=node=/absolute/node] [--tool=npm=/absolute/npm]
 * Root is cwd, must match manifest; no PATH lookup or auto-install.
 * serve executes the declared steps, then serves only after success and health proof.
 * Example JSON projectRoot must be edited to the actual canonical project directory.
 * Build approval does not authorize installs/network; this is not a sandbox.
 * Windows tool paths must be native .exe files; .cmd/.bat wrappers are refused.
 * validate is lexical only; run preflights filesystem identities before spawning.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat, open, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createRunPlan} from './execution-policy.mjs';
import {runPlan, serveArtifacts} from './runtime-runner.mjs';

async function readManifest(root, relative) {
  if (typeof relative !== 'string' || relative.length > 4096 ||
      !relative.endsWith('.json') || /[\\\x00-\x1f:]/.test(relative) ||
      path.isAbsolute(relative) ||
      relative.split('/').some(part => !part || part === '.' || part === '..' ||
        /[. ]$/.test(part) || /["*?<>|\x7f]/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    throw new TypeError('Manifest must be a bounded relative JSON path');
  let current = root, expected;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await lstat(current);
    if (i === parts.length - 1) expected = stat;
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) ||
        (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1)))
      throw new TypeError('Manifest links or non-files refused');
  }
  const canonical = await realpath(current);
  const rel = path.relative(root, canonical);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
    throw new TypeError('Manifest outside project');
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144 || !same(expected, stat))
      throw new TypeError('Invalid or oversized manifest');
    const bytes = Buffer.alloc(262145);
    let count = 0;
    while (count < bytes.length) {
      const {bytesRead} = await handle.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (count > 262144 || count !== stat.size || after.nlink !== 1 || !same(stat, after))
      throw new TypeError('Oversized or concurrently changed manifest');
    return JSON.parse(bytes.subarray(0, count).toString('utf8'));
  } finally { await handle.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  const [action, filename, ...flags] = argv;
  if (!['validate', 'run', 'test', 'build', 'serve'].includes(action))
    throw new TypeError('Usage: validate|run|test|build|serve manifest.json [--allow-build] [--allow-serve] [--tool=name=absolutePath]');
  let allowBuild = false, allowServe = false;
  const toolPaths = {node: process.execPath};
  const seen = new Set();
  for (const flag of flags) {
    if (flag === '--allow-build' && !seen.has(flag)) {
      seen.add(flag); allowBuild = true;
    } else if (flag === '--allow-serve' && !seen.has(flag)) {
      seen.add(flag); allowServe = true;
    } else {
      const match = /^--tool=(node|npm|dotnet|cargo|cmake)=(.+)$/.exec(flag);
      if (!match || seen.has(match[1])) throw new TypeError('Unknown or duplicate option');
      seen.add(match[1]); toolPaths[match[1]] = match[2];
    }
  }
  const projectRoot = await realpath(process.cwd());
  const manifest = await readManifest(projectRoot, filename);
  const context = {projectRoot, toolPaths, allowBuild, allowServe};
  const plan = createRunPlan(manifest, context);
  if (action === 'test' && plan.commands.some(command => command.kind !== 'test'))
    throw new TypeError('test action requires test-only manifest');
  if (action === 'build' && !plan.commands.some(command => command.kind !== 'test'))
    throw new TypeError('build action requires explicit build/compile step');
  if (action === 'serve' && (!allowServe || !plan.serve))
    throw new TypeError('serve requires --allow-serve and an explicit manifest artifact directory');
  if (action === 'validate') return {validated: true, plan};
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  let serving;
  const removeSignals = () => {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  };
  try {
    const run = await runPlan(plan, {context, signal: controller.signal});
    if (action !== 'serve' || run.status !== 'passed') return run;
    serving = await serveArtifacts({plan, context, runResult: run, signal: controller.signal});
    if (controller.signal.aborted) {
      await serving.close();
      serving = null;
      throw new Error('Serving cancelled');
    }
    controller.signal.addEventListener('abort', removeSignals, {once: true});
    return {
      status: 'serving', run, url: serving.url,
      get healthProof() { return serving.healthProof; },
      close: async () => {
        removeSignals();
        controller.signal.removeEventListener('abort', removeSignals);
        await serving.close();
      }
    };
  } finally { if (!serving) removeSignals(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.status && !['passed', 'serving'].includes(result.status)) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(String(error.message || error).slice(0, 2048) + '\n');
    process.exitCode = 1;
  });
}
