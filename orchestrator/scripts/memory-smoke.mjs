// Local-only acceptance probe. Synthetic records; retained for inspection, never touches real chats.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryStore } from '../src/memory.mjs';
import { rememberConversation } from '../src/experience.mjs';
const dir = `D:/HomeAI/evaluations/memory-smoke-${Date.now()}`;
mkdirSync(dir, { recursive: true });
const memory = createMemoryStore(join(dir, 'memory'));
const messages = Array.from({ length: 400 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
  text: `Garden maintenance entry ${i}: ${'Check paths and water plants. '.repeat(12)}` }));
messages[112] = { role: 'user', text: 'Synthetic test only: the zephyr calibration constant is 0.937. Keep this exact number.' };
rememberConversation(memory, { id: 'synthetic-calibration', title: 'Synthetic maintenance', messages });
const context = memory.context('zephyr calibration constant', { format: 'mcl', maxChars: 1200, limit: 6 });
const report = { rawChars: JSON.stringify(messages).length, retrievedChars: context.length, containsExactValue: context.includes('0.937'), models: [] };
for (const model of ['homeai-fast:locked', 'qwen3-4b-instruct-2507-heretic-exp:latest']) {
  try {
    const res = await fetch('http://127.0.0.1:11435/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, think: false, messages: [
        { role: 'system', content: `Answer from retrieved source data only. MCL ? denotes unverified source material.\n${context}` },
        { role: 'user', content: 'What is the zephyr calibration constant? Reply with only the number.' }
      ], options: { num_ctx: 4096, num_predict: 64, temperature: 0 } }), signal: AbortSignal.timeout(120000) });
    if (!res.ok) { report.models.push({ model, ok: false, httpStatus: res.status }); continue; }
    const body = await res.json();
    report.models.push({ model, ok: /\b0\.937\b/.test(body.message?.content ?? ''), inputTokens: body.prompt_eval_count, outputTokens: body.eval_count });
  } catch { report.models.push({ model, ok: false, error: 'Local request failed or timed out; provider details not printed.' }); }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ dir, ...report }, null, 2));
if (!report.containsExactValue || report.models.some(m => !m.ok)) process.exitCode = 1;
