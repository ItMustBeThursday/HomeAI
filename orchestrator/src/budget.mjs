// How much conversation/memory text a model can be given. Small local models get a tighter, compressed prompt;
// CLI models (Claude/Codex) have large windows. Character budgets, since no tokenizer is available: ~4 chars per token.
// Every local (Ollama) model is given the SAME explicit window unless its connector sets ctx. Before, connectors without ctx
// let Ollama pick (observed 16384 here) while others were pinned at 4096, so models saw different amounts of context, and a
// changing num_ctx between calls (auto-route classifier vs. main call) forces Ollama to reload the model.
export const LOCAL_CTX = 8192;
export const OLLAMA_DEFAULT_CTX = LOCAL_CTX;
const CLI_CHARS = 60_000;
const HISTORY_SHARE = 0.4;   // of the window: conversation history
const MEMORY_SHARE = 0.06;   // of the window: durable memory block (bounded 1200..6000 chars)

// entry: a resolved chain entry or connector ({kind, ctx?}). ctx is in tokens.
export function windowTokens(entry) {
  if (entry?.kind === 'ollama') return effectiveCtx(entry);
  return Infinity;
}
// The ctx to send to Ollama: always explicit, so the budget used to build the prompt equals the window the model really has.
export function effectiveCtx(entry) {
  return Number.isInteger(entry?.ctx) && entry.ctx >= 2048 ? entry.ctx : LOCAL_CTX;
}
export function historyChars(entries) {
  const text = entries.filter((e) => e && e.kind !== 'comfyui');
  if (!text.length) return 12_000;
  return Math.max(4000, Math.min(...text.map((e) => (Number.isFinite(windowTokens(e)) ? Math.floor(windowTokens(e) * 4 * HISTORY_SHARE) : CLI_CHARS))));
}
export function memoryChars(entries) {
  const text = entries.filter((e) => e && e.kind !== 'comfyui');
  if (!text.length) return 1800;
  const w = Math.min(...text.map((e) => (Number.isFinite(windowTokens(e)) ? windowTokens(e) : 200_000)));
  return Math.max(1200, Math.min(6000, Math.floor(w * 4 * MEMORY_SHARE)));
}
