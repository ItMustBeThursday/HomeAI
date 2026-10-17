import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResponse, asksForService, SERVICE } from './mdns.mjs';

const query = (labels, type) => {
  const parts = labels.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  const h = Buffer.alloc(12); h.writeUInt16BE(1, 4);
  const t = Buffer.alloc(4); t.writeUInt16BE(type, 0); t.writeUInt16BE(1, 2);
  return Buffer.concat([h, ...parts, Buffer.from([0]), t]);
};

test('answers a PTR query for the HoopyFrood service and ignores others', () => {
  assert.equal(asksForService(query(SERVICE, 12)), true);
  assert.equal(asksForService(query('_http._tcp.local', 12)), false);
  assert.equal(asksForService(buildResponse({ instance: 'x', host: 'h', port: 1, addresses: ['192.168.1.2'] })), false); // our own announcement
  assert.equal(asksForService(Buffer.from([1, 2, 3])), false);
});

test('announcement carries PTR, SRV, TXT and A records with the port and address', () => {
  const b = buildResponse({ instance: 'HomePC', host: 'homepc', port: 18850, addresses: ['192.168.1.20'], txt: { v: '0.33.0' } });
  assert.equal(b.readUInt16BE(2), 0x8400);
  assert.equal(b.readUInt16BE(6), 1);
  assert.equal(b.readUInt16BE(10), 3); // SRV + TXT + A as additional
  const hex = b.toString('hex');
  assert.ok(hex.includes((18850).toString(16).padStart(4, '0')));
  assert.ok(hex.includes('c0a80114')); // 192.168.1.20
  assert.ok(b.includes(Buffer.from('v=0.33.0')));
});
