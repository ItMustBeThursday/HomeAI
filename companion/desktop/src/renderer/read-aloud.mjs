// Uses the platform speech engine; no microphone or Gateway permission needed.
export function createReadAloud({ synthesis, Utterance, onState = () => {}, onError = () => {} } = {}) {
  let active = null;
  const supported = !!synthesis && typeof synthesis.speak === 'function' &&
    typeof synthesis.cancel === 'function' && typeof Utterance === 'function';
  function stop() {
    active = null; // Invalidate callbacks before cancel(), which may fire synchronously.
    if (supported) synthesis.cancel();
    onState(false);
  }
  function speak(value) {
    stop();
    if (!supported) { onError('Read aloud is unavailable on this device.'); return false; }
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return false;
    // Short utterances avoid platform length limits; queue only one at a time.
    const chunks = text.match(/[\s\S]{1,240}(?:\s|$)|[\s\S]{1,240}/g);
    const run = {};
    active = run;
    onState(true);
    let index = 0;
    function next() {
      if (active !== run) return;
      if (index === chunks.length) { active = null; onState(false); return; }
      try {
        const utterance = new Utterance(chunks[index++]);
        run.utterance = utterance; // Retain until the platform finishes.
        utterance.onend = () => { if (run.utterance === utterance) { run.utterance = null; next(); } };
        utterance.onerror = () => {
          if (active !== run || run.utterance !== utterance) return;
          stop();
          onError('Could not read this response aloud. Check your device voice settings.');
        };
        synthesis.speak(utterance);
      } catch {
        if (active === run) { stop(); onError('Could not start read aloud. Check your device voice settings.'); }
      }
    }
    next();
    return active === run;
  }
  return { supported, speak, stop, get speaking() { return active !== null; } };
}
