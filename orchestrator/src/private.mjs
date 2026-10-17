// Private chat sessions. Everything lives in this process's memory plus one scratch folder per session
// (<root>/<id>); closing a session, an idle timeout, a service restart or a crash all end with that folder gone.
// Nothing here touches chat history, task history, the usage ledger, memory or the shared media library.
import { mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAttachmentStore } from './attachments.mjs';

export function createPrivateSessions({ root, ttlMs = 30 * 60_000, now = Date.now, newId = randomUUID, sweepMs = 60_000 } = {}) {
  if (!root || basename(root) !== 'private') throw new Error('private sessions need a folder named "private"');
  const sessions = new Map();
  // Anything found here at start-up is left over from a crash or kill: wipe it.
  const wipe = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  wipe(root);
  mkdirSync(root, { recursive: true });

  function close(id) {
    const s = sessions.get(id);
    if (!s) return false;
    sessions.delete(id);
    s.closed = true;
    s.abort?.abort();
    wipe(s.dir);
    return true;
  }

  const timer = setInterval(() => {
    for (const [id, s] of sessions) if (!s.abort && now() - s.seen > ttlMs) close(id);
  }, sweepMs);
  timer.unref();

  return {
    ttlMs,
    create() {
      const id = newId();
      const dir = join(root, id);
      mkdirSync(join(dir, 'media'), { recursive: true });
      const s = { id, dir, mediaDir: join(dir, 'media'), messages: [], seen: now(), abort: null, closed: false, attachments: null };
      s.images = () => (s.attachments ??= createAttachmentStore(join(dir, 'attachments')));
      sessions.set(id, s);
      return s;
    },
    get(id) {
      const s = sessions.get(id);
      if (s) s.seen = now();
      return s ?? null;
    },
    close,
    closeAll() {
      for (const id of [...sessions.keys()]) close(id);
    },
    count: () => sessions.size,
    // Generated files of a session, newest first (names only).
    files(id) {
      const s = sessions.get(id);
      if (!s || !existsSync(s.mediaDir)) return [];
      return readdirSync(s.mediaDir).map((name) => ({ name, size: statSync(join(s.mediaDir, name)).size }));
    },
  };
}
