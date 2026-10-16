// Image attachments (data/attachments/<id>.<ext>). Content-addressed, so the same picture is stored once.
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const ID = /^[a-f0-9]{24}\.(png|jpg|webp|gif)$/;

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Checks the bytes really are the claimed format, so a renamed file isn't passed to a model as an image.
function sniff(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}

export function createAttachmentStore(dir) {
  mkdirSync(dir, { recursive: true });
  const pathOf = (id) => {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid attachment id');
    return join(dir, id);
  };
  return {
    // images: [{ name, mediaType, data(base64) }] → [{ id, name, mediaType, path, bytes }]
    saveAll(images) {
      if (images === undefined) return [];
      if (!Array.isArray(images)) throw new Error('images must be an array');
      if (images.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per message`);
      return images.map((img, n) => {
        if (img === null || typeof img !== 'object') throw new Error(`Image ${n + 1} must be an object`);
        if (!Object.hasOwn(TYPES, img.mediaType)) throw new Error(`Image ${n + 1}: unsupported type "${img.mediaType}" (png, jpeg, webp or gif)`);
        if (typeof img.data !== 'string' || !img.data) throw new Error(`Image ${n + 1}: data must be a base64 string`);
        const buf = Buffer.from(img.data, 'base64');
        if (buf.length === 0) throw new Error(`Image ${n + 1} is empty`);
        if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image ${n + 1} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
        const real = sniff(buf);
        if (real !== img.mediaType) throw new Error(`Image ${n + 1}: contents are not ${img.mediaType}`);
        const id = `${createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${TYPES[img.mediaType]}`;
        const path = join(dir, id);
        if (!existsSync(path)) writeFileSync(path, buf);
        return { id, name: String(img.name ?? `image-${n + 1}`).slice(0, 80), mediaType: img.mediaType, path, bytes: buf.length };
      });
    },
    // Resolves ids saved earlier back to runnable attachments.
    resolve(refs) {
      return refs.map((r) => {
        const path = pathOf(r.id);
        if (!existsSync(path)) throw new Error(`Attachment ${r.id} not found`);
        return { ...r, path };
      });
    },
    file(id) {
      const path = pathOf(id);
      if (!existsSync(path)) return null;
      const ext = id.split('.').pop();
      return { path, mediaType: Object.keys(TYPES).find((t) => TYPES[t] === ext) };
    },
    count: () => readdirSync(dir).length,
  };
}
