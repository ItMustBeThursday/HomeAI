// Deterministic, local-only experience index. Original transcripts remain authoritative.
// Each bounded excerpt keeps its role and source; assistant reports are never verified facts.
import { excludedConversation } from './memory-policy.mjs';
const SIZE = 360;
export function redactMemory(text) {
  return String(text ?? '').replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b((?:api[_-]?key|password|passwd|token|secret)\s*[:=]\s*)["']?[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[redacted]');
}
function chunks(text) {
  const out = [];
  let rest = redactMemory(text).trim();
  while (rest) {
    let end = Math.min(SIZE, rest.length);
    if (end < rest.length) {
      const boundary = rest.lastIndexOf(' ', end);
      if (boundary > SIZE / 2) end = boundary;
    }
    out.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  return out;
}
function put(memory, fields, known) {
  if (memory.isRetiredEpisode?.(fields.source)) return 0;
  fields = { ...fields, title: fields.title.trim(), text: fields.text.trim() };
  const old = known.get(fields.source);
  if (old?.text === fields.text && old?.title === fields.title) return 0;
  const saved = memory.add(fields);
  known.set(fields.source, fields);
  return saved?.duplicateOf ? 0 : 1; // a repeat of an excerpt already stored is not stored again
}
export function rememberConversation(memory, conv, { known = new Map(memory.list().map(n => [n.source, n])), from = 0 } = {}) {
  if (!conv || conv.private || excludedConversation(conv)) return 0;
  let count = 0;
  for (let i = from; i < (conv.messages ?? []).length; i++) {
    const m = conv.messages[i];
    if (!['user', 'assistant'].includes(m.role)) continue;
    const label = m.role === 'user' ? 'User said' : m.error ? 'Failed assistant report (unverified)' : 'Assistant report (unverified)';
    const text = m.error ? `${m.text ?? ''}\nError: ${m.error}` : m.text;
    chunks(text).forEach((part, j) => {
      count += put(memory, { title: `${conv.title || 'Chat'} / ${m.role} ${i + 1}.${j + 1}`.slice(0, 120),
        text: `${label}: ${part}`, source: `turn:${conv.id}:${i}:${j}`, tags: ['chat', 'episode'],
        scope: 'chat', kind: 'open', pri: 0 }, known);
    });
  }
  return count;
}
export function rememberTask(memory, task, known = new Map(memory.list().map(n => [n.source, n]))) {
  if (!task?.id || task.conversationId || task.source === 'private') return 0;
  let count = 0;
  for (const [role, text] of [['request', task.prompt], ['report', task.text || task.error]]) {
    chunks(text).forEach((part, j) => {
      count += put(memory, { title: `${task.taskType || 'Task'} ${role} ${j + 1}`, text: `${role === 'request' ? 'User/task request' : 'Model report (unverified)'}: ${part}`,
        source: `task:${task.id}:${role}:${j}`, tags: ['task', 'episode'], scope: 'task', kind: 'open', pri: 0 }, known);
    });
  }
  return count;
}
export function backfillExperiences(memory, conversations, history) {
  const known = new Map(memory.list().map(n => [n.source, n]));
  let written = 0, errors = 0;
  for (const state of ['active', 'archived']) {
    for (const c of conversations.list(state)) {
      try { written += rememberConversation(memory, conversations.get(c.id), { known }); }
      catch { errors++; }
    }
  }
  for (const task of history?.list(1000) ?? []) {
    try { written += rememberTask(memory, task, known); } catch { errors++; }
  }
  return { written, errors };
}
