// Minimal mDNS/DNS-SD advertiser for "_homeai._tcp.local" so phones and laptops on the same Wi-Fi can find the
// orchestrator without typing an IP. It answers PTR queries for the service type and announces on start.
// It only advertises name, port, version and this PC's private IPv4 addresses - no tokens, no paths.
import dgram from 'node:dgram';

export const SERVICE = '_homeai._tcp.local';
const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

const name = (n) => Buffer.concat([...n.split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const rr = (n, type, data, ttl = 120) => Buffer.concat([name(n), u16(type), u16(0x8001), u32(ttl), u16(data.length), data]);

export function buildResponse({ instance, host, port, addresses, txt = {} }) {
  const inst = `${instance}.${SERVICE}`;
  const hostName = `${host}.local`;
  const ptr = rr(SERVICE, 12, name(inst));
  const srv = rr(inst, 33, Buffer.concat([u16(0), u16(0), u16(port), name(hostName)]));
  const txtData = Object.entries(txt).map(([k, v]) => { const s = Buffer.from(`${k}=${v}`); return Buffer.concat([Buffer.from([s.length]), s]); });
  const txtRec = rr(inst, 16, txtData.length ? Buffer.concat(txtData) : Buffer.from([0]));
  const as = addresses.map((a) => rr(hostName, 1, Buffer.from(a.split('.').map(Number))));
  const records = [ptr, srv, txtRec, ...as];
  const header = Buffer.concat([u16(0), u16(0x8400), u16(0), u16(1), u16(0), u16(records.length - 1)]);
  return Buffer.concat([header, ...records]);
}

// Does this packet ask for our service type (PTR) or ANY of it? Tolerates compression pointers only in names we don't need.
export function asksForService(buf) {
  try {
    if (buf.length < 12 || (buf.readUInt16BE(2) & 0x8000)) return false; // too short, or a response
    let off = 12;
    const qd = buf.readUInt16BE(4);
    for (let i = 0; i < qd; i++) {
      const labels = [];
      while (buf[off] !== 0) {
        if ((buf[off] & 0xc0) === 0xc0) return false;
        labels.push(buf.toString('utf8', off + 1, off + 1 + buf[off]));
        off += buf[off] + 1;
      }
      off += 1;
      const type = buf.readUInt16BE(off);
      off += 4;
      if (labels.join('.').toLowerCase() === SERVICE && (type === 12 || type === 255)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function startMdns({ instance, host, port, addresses, txt, socketFactory = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }) }) {
  if (!addresses.length) return { stop() {} };
  const response = buildResponse({ instance, host, port, addresses, txt });
  const sock = socketFactory();
  let timer;
  const send = () => sock.send(response, MDNS_PORT, MDNS_ADDR, () => {});
  sock.on('error', () => {}); // advertising is best effort; never take the service down
  sock.on('message', (msg) => { if (asksForService(msg)) send(); });
  sock.bind(MDNS_PORT, () => {
    try {
      sock.setMulticastTTL(255);
      sock.setMulticastInterface(addresses[0]);
      for (const a of addresses) sock.addMembership(MDNS_ADDR, a);
    } catch {}
    send();
    timer = setInterval(send, 60_000);
    timer.unref?.();
  });
  return { stop() { clearInterval(timer); try { sock.close(); } catch {} } };
}
