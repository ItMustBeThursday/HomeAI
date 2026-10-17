// Thin client for the local voice service (projects/voice/voice_server.py on 127.0.0.1:18870):
// speech-to-text, text-to-speech and voice cloning. Audio and voice samples never leave this PC.
export function createVoice({ url = process.env.HOMEAI_VOICE_URL ?? 'http://127.0.0.1:18870', fetchImpl = fetch } = {}) {
  async function call(path, init = {}, timeout = 180_000) {
    let res;
    try {
      res = await fetchImpl(url + path, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch {
      const e = new Error('Voice service is unavailable or the audio request timed out');
      e.status = 503;
      throw e;
    }
    if (!res.ok) {
      const e = new Error((await res.json().catch(() => ({}))).detail || `Voice service error ${res.status}`);
      e.status = [400, 404, 413, 422].includes(res.status) ? res.status : 502;
      throw e;
    }
    return res;
  }
  const json = async (path, init, t) => (await call(path, init, t)).json();
  return {
    status: () => json('/health', {}, 5000),
    voices: () => json('/voices', {}, 30_000),
    stt: (buf, lang) => json(`/stt${lang ? `?lang=${encodeURIComponent(lang)}` : ''}`, { method: 'POST', body: buf }),
    clone: (name, buf) => json(`/clone/${encodeURIComponent(name)}`, { method: 'POST', body: buf }, 60_000),
    remove: (name) => json(`/clone/${encodeURIComponent(name)}`, { method: 'DELETE' }, 10_000),
    async tts(body) {
      const res = await call('/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 600_000);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
