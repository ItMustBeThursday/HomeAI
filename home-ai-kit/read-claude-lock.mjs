import { readFileSync } from 'node:fs';

// npm lockfiles contain a packages[""] entry that Windows PowerShell 5.1
// cannot turn into a PSCustomObject. Parse in Node and return only our entry.
try {
  const lock = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  const entry = lock.packages?.['node_modules/@anthropic-ai/claude-code-win32-x64'];
  if (!entry || typeof entry.integrity !== 'string' || typeof entry.resolved !== 'string') {
    throw new Error('Claude package entry is missing or invalid in the npm lockfile.');
  }
  process.stdout.write(JSON.stringify({ integrity: entry.integrity, resolved: entry.resolved }));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
