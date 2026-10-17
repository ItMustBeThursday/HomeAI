// Per-key concurrency limiter: at most `limits[key]` (default `fallback`) calls run at once; the rest queue FIFO.
export function createLimiter({ limits = {}, fallback = 1 } = {}) {
  for (const [k, v] of Object.entries({ ...limits, fallback })) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`Limit for "${k}" must be a positive integer`);
  }
  const state = new Map();
  const limitFor = key => Object.hasOwn(limits, key) ? limits[key] : fallback;
  const get = (key) => state.get(key) ?? state.set(key, { active: 0, queue: [] }).get(key);
  return {
    run(key, fn) {
      const s = get(key);
      const max = limitFor(key);
      return new Promise((resolve, reject) => {
        const start = () => {
          s.active += 1;
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              s.active -= 1;
              s.queue.shift()?.();
            });
        };
        if (s.active < max) start();
        else s.queue.push(start);
      });
    },
    stats() {
      return Object.fromEntries([...state].map(([k, s]) => [k, { active: s.active, queued: s.queue.length, limit: limitFor(k) }]));
    },
  };
}
