import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2]);
const packageFile = path.join(root, 'package.json');
const require = createRequire(packageFile);
const checks = [];
function check(name, test) {
  try {
    test();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, error: String(error.message).slice(0, 500) });
  }
}
check('esbuild', () => require('esbuild').transformSync('const value = 1;', { loader: 'js' }));
check('koffi', () => {
  const binding = require('koffi');
  if (typeof binding.load !== 'function') throw new Error('Native binding did not load.');
});
check('openclaw', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/openclaw/package.json'), 'utf8'));
  if (pkg.version !== '2026.10.3') throw new Error('This continuation expects OpenClaw 2026.10.3.');
});
console.log(JSON.stringify({ checks, passed: checks.every((item) => item.passed) }));
process.exitCode = checks.every((item) => item.passed) ? 0 : 1;
