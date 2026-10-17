// One-time pairing codes so a phone or laptop on the home network can get its own limited device token.
// The admin (on this PC) starts a pairing; the device claims it with the code. Codes are 6 digits, single use,
// expire after 5 minutes, and repeated wrong guesses lock claiming for a while.
import { randomInt } from 'node:crypto';

export const PAIR_SCOPES = ['read', 'chat'];

export function createPairing({ auth, now = Date.now, ttlMs = 5 * 60_000, maxFailures = 5, lockMs = 5 * 60_000, rand = () => randomInt(0, 1_000_000) } = {}) {
  if (!auth) throw new Error('auth is required');
  let current = null; // { code, expires }
  let failures = 0;
  let lockedUntil = 0;
  return {
    start() {
      current = { code: String(rand()).padStart(6, '0'), expires: now() + ttlMs };
      return { code: current.code, expiresAt: current.expires, ttlSeconds: Math.round(ttlMs / 1000), scopes: PAIR_SCOPES };
    },
    cancel() {
      current = null;
    },
    pending: () => (current && current.expires > now() ? { expiresAt: current.expires } : null),
    // → { token, device } or throws an Error with .status
    claim(code, name) {
      const t = now();
      const fail = (status, msg) => Object.assign(new Error(msg), { status });
      if (t < lockedUntil) throw fail(429, 'Too many wrong codes. Wait a few minutes and start a new pairing on the PC.');
      if (typeof name !== 'string' || !name.trim()) throw fail(400, 'Device name is required');
      const ok = current && current.expires > t && typeof code === 'string' && code.length === 6 && code === current.code;
      if (!ok) {
        failures += 1;
        if (failures >= maxFailures) {
          lockedUntil = t + lockMs;
          failures = 0;
          current = null;
        }
        throw fail(403, 'Wrong or expired pairing code');
      }
      current = null; // single use
      failures = 0;
      return auth.addDevice({ name, scopes: PAIR_SCOPES });
    },
  };
}
