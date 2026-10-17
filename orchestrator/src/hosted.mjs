// Hosted free-tier LLM client (OpenAI-compatible /chat/completions). Standalone: it is NOT a router connector,
// so chat memory, private sessions and agent tools can never reach it. Only the swarm calls it, with scrubbed prompts.
// Keys come from environment variables named in config/free-providers.json (never from files, never logged).
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bAIza[0-9A-Za-z_-]{30,}/, /\bgsk_[A-Za-z0-9]{20,}/,
  /\bnvapi-[A-Za-z0-9_-]{20,}/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*\S{8,}/i, /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
];
export const looksSensitive = (text) => SECRET_SHAPES.some((re) => re.test(String(text)));

export const redact = (text, key) => {
  let s = String(text ?? '');
  if (key) s = s.split(key).join('[redacted]');
  return SECRET_SHAPES.reduce((acc, re) => acc.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), '[redacted]'), s);
};

export class HostedError extends Error {
  constructor(message, { status, rateLimited = false, retryAfterMs } = {}) {
    super(message);
    this.status = status;
    this.rateLimited = rateLimited;
    this.retryAfterMs = retryAfterMs;
  }
}

export function createHostedClient({ fetchImpl = fetch, env = process.env, timeoutMs = 90_000 } = {}) {
  return async function call(provider, model, { prompt, system, maxTokens = 1024, signal } = {}) {
    if (!/^https:\/\//.test(provider.baseUrl)) throw new HostedError(`${provider.id}: baseUrl must be https`);
    const key = env[provider.keyEnv];
    if (!key) throw new HostedError(`${provider.id}: ${provider.keyEnv} is not set`, { status: 0 });
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
    const ctrl = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let res;
    try {
      res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ctrl,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(provider.headers ?? {}) },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3, stream: false }),
      });
    } catch (err) {
      throw new HostedError(`${provider.id}: ${redact(err.message, key)}`);
    }
    const raw = await res.text();
    if (!res.ok) {
      const ra = Number(res.headers?.get?.('retry-after'));
      throw new HostedError(`${provider.id}: HTTP ${res.status} ${redact(raw, key).slice(0, 200)}`, { status: res.status, rateLimited: res.status === 429, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined });
    }
    let json;
    try { json = JSON.parse(raw); } catch { throw new HostedError(`${provider.id}: non-JSON response`); }
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new HostedError(`${provider.id}: empty completion`);
    return { text, inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0, costUsd: 0, ok: true };
  };
}
