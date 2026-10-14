import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function runNative({executable, args, cwd, input = '', timeoutSeconds = 900}) {
  return await new Promise(resolve => {
    const child = spawn(executable, args, {cwd, shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe']});
    let stdout = '', stderr = '', timedOut = false, oversized = false, done = false;
    const finish = (code, error = null) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({code, stdout, stderr, timedOut, oversized, error});
    };
    const collect = (stream, field) => {
      stream.setEncoding('utf8');
      stream.on('data', text => {
        if (field === 'stdout') stdout += text; else stderr += text;
        if (stdout.length + stderr.length > 8_000_000) {
          oversized = true; child.kill();
        }
      });
    };
    collect(child.stdout, 'stdout'); collect(child.stderr, 'stderr');
    const timer = setTimeout(() => {timedOut = true; child.kill();}, timeoutSeconds * 1000);
    child.on('error', error => finish(1, error.message));
    child.on('close', code => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function parseCodexResult(result) {
  let answer = '', completed = false, failed = false, errors = '';
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {event = JSON.parse(line);} catch {continue;}
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text ?? '';
    if (event.type === 'turn.completed') completed = true;
    if (event.type === 'turn.failed' || event.type === 'error') {
      failed = true; errors += JSON.stringify(event) + '\n';
    }
  }
  const success = result.code === 0 && completed && !failed && !result.timedOut && !result.oversized && !!answer;
  // Inspect failures only: a successful answer may discuss rate limits.
  const limited = !success && /rate.?limit|usage.?limit|hit your limit|quota|usage_limit_reached|insufficient_quota/i.test(errors + result.stderr);
  return {success, limited, answer: success ? answer : '', reason: success ? 'completed' : result.timedOut ? 'timeout' : limited ? 'usage-limit' : 'incomplete-or-failed'};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input.replace(/^\uFEFF/, ''));
    const result = await runNative(request);
    // ASCII JSON survives Windows PowerShell 5.1's OEM stdout decoder;
    // ConvertFrom-Json restores Unicode after decoding this transport envelope.
    const json = JSON.stringify(request.parseCodex ? parseCodexResult(result) : result);
    process.stdout.write(json.replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
  } catch (error) {
    process.stderr.write(`${error.message}\n`); process.exitCode = 1;
  }
}
