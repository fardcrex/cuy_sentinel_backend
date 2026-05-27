'use strict';
/**
 * Minimal SNMP v2c GET responder.
 * Responds to the exact OIDs queried by node_collector/src/collector/snmpCollector.js
 * Uses only Node.js built-ins (dgram) — no npm dependencies.
 */
const dgram = require('dgram');

const PORT = parseInt(process.env.SNMP_PORT || '161');

// ─── Simulated state ──────────────────────────────────────────────────────────

function rand(min, max) { return Math.random() * (max - min) + min; }
function randInt(min, max) { return Math.floor(rand(min, max)); }

const s = {
  uptimeTicks:  randInt(86400, 7 * 86400) * 100,
  ifInOctets:   randInt(50_000_000, 300_000_000),
  ifOutOctets:  randInt(20_000_000, 100_000_000),
  diskUsed:     randInt(30, 65),  // allocation units (out of 100)
  diskSize:     100,
  diskAlloc:    1_073_741_824,    // 1 GB per unit → 100 GB disk
  memUsed:      randInt(1024, 2800),  // allocation units (out of 4096)
  memTotal:     4096,
  memAlloc:     1_048_576,        // 1 MB per unit → 4 GB RAM
  cpuLoad:      randInt(15, 65),  // percent
};

setInterval(() => {
  s.uptimeTicks += 3000;
  s.ifInOctets  += randInt(1_000_000, 12_000_000);
  s.ifOutOctets += randInt(400_000,    5_000_000);
  s.memUsed  = Math.max(512,  Math.min(3800, s.memUsed  + randInt(-200, 200)));
  s.cpuLoad  = Math.max(5,    Math.min(95,   s.cpuLoad  + randInt(-15,  15)));
  s.diskUsed = Math.min(s.diskSize - 1, s.diskUsed + (Math.random() > 0.9 ? 1 : 0));
}, 30_000);

// ─── BER encoding ─────────────────────────────────────────────────────────────

function encLen(n) {
  if (n < 128) return [n];
  if (n < 256) return [0x81, n];
  return [0x82, (n >> 8) & 0xff, n & 0xff];
}

function tlv(tag, valueBytes) {
  return Buffer.concat([Buffer.from([tag, ...encLen(valueBytes.length)]), valueBytes]);
}

function encInt(n) {
  const bytes = [];
  let x = n;
  do { bytes.unshift(x & 0xff); x >>= 8; } while (x !== 0 && x !== -1);
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return tlv(0x02, Buffer.from(bytes));
}

function encUnsigned(tag, n) {
  n = n >>> 0;
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  let start = 0;
  while (start < 3 && b[start] === 0) start++;
  const slice = b.slice(start);
  const val = (slice[0] & 0x80) ? Buffer.concat([Buffer.from([0]), slice]) : slice;
  return tlv(tag, val);
}

const encCounter32 = (n) => encUnsigned(0x41, n);
const encTimeTicks = (n) => encUnsigned(0x43, n);
const encGauge32   = (n) => encUnsigned(0x42, n);

function encOID(str) {
  const parts = str.replace(/^\./, '').split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    const sub = [n & 0x7f];
    n >>= 7;
    while (n > 0) { sub.unshift((n & 0x7f) | 0x80); n >>= 7; }
    bytes.push(...sub);
  }
  return tlv(0x06, Buffer.from(bytes));
}

// ─── OID → value map ──────────────────────────────────────────────────────────

const OID_VALUES = {
  '1.3.6.1.2.1.1.3.0':        () => encTimeTicks(s.uptimeTicks),
  '1.3.6.1.2.1.2.2.1.10.1':   () => encCounter32(s.ifInOctets),
  '1.3.6.1.2.1.2.2.1.16.1':   () => encCounter32(s.ifOutOctets),
  '1.3.6.1.2.1.25.2.3.1.6.1': () => encGauge32(s.diskUsed),
  '1.3.6.1.2.1.25.2.3.1.5.1': () => encGauge32(s.diskSize),
  '1.3.6.1.2.1.25.2.3.1.4.1': () => encInt(s.diskAlloc),
  '1.3.6.1.2.1.25.2.3.1.6.2': () => encGauge32(s.memUsed),
  '1.3.6.1.2.1.25.2.3.1.5.2': () => encGauge32(s.memTotal),
  '1.3.6.1.2.1.25.2.3.1.4.2': () => encInt(s.memAlloc),
  '1.3.6.1.2.1.25.3.3.1.2.1': () => encGauge32(s.cpuLoad),
};

// ─── BER parsing ──────────────────────────────────────────────────────────────

function readLen(buf, off) {
  const first = buf[off];
  if (first < 128) return { len: first, consumed: 1 };
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[off + 1 + i];
  return { len, consumed: 1 + n };
}

function readTLV(buf, off) {
  const tag = buf[off];
  const { len, consumed } = readLen(buf, off + 1);
  const value = buf.slice(off + 1 + consumed, off + 1 + consumed + len);
  return { tag, value, total: 1 + consumed + len };
}

function parseOID(buf) {
  const parts = [Math.floor(buf[0] / 40), buf[0] % 40];
  let i = 1;
  while (i < buf.length) {
    let n = 0;
    while (buf[i] & 0x80) { n = (n << 7) | (buf[i] & 0x7f); i++; }
    n = (n << 7) | buf[i++];
    parts.push(n);
  }
  return parts.join('.');
}

function parsePacket(pkt) {
  try {
    const outer = readTLV(pkt, 0);
    let iOff = 0;
    const version  = readTLV(outer.value, iOff); iOff += version.total;
    const community = readTLV(outer.value, iOff); iOff += community.total;
    const pdu = readTLV(outer.value, iOff);
    if (pdu.tag !== 0xa0) return null;

    let pOff = 0;
    const reqId = readTLV(pdu.value, pOff); pOff += reqId.total;
    pOff += readTLV(pdu.value, pOff).total; // error-status
    pOff += readTLV(pdu.value, pOff).total; // error-index
    const vbl = readTLV(pdu.value, pOff);

    const oids = [];
    let vOff = 0;
    while (vOff < vbl.value.length) {
      const vb = readTLV(vbl.value, vOff); vOff += vb.total;
      const oidTLV = readTLV(vb.value, 0);
      oids.push(parseOID(oidTLV.value));
    }
    return { version: version.value, community: community.value, reqIdBytes: reqId.value, oids };
  } catch (_) {
    return null;
  }
}

// ─── Build GET response ───────────────────────────────────────────────────────

function buildResponse(parsed) {
  const varbinds = parsed.oids.map(oid => {
    const valueBuf = OID_VALUES[oid] ? OID_VALUES[oid]() : tlv(0x05, Buffer.alloc(0));
    return tlv(0x30, Buffer.concat([encOID(oid), valueBuf]));
  });
  const pduContent = Buffer.concat([
    tlv(0x02, parsed.reqIdBytes),
    encInt(0), encInt(0),
    tlv(0x30, Buffer.concat(varbinds)),
  ]);
  return tlv(0x30, Buffer.concat([
    tlv(0x02, parsed.version),
    tlv(0x04, parsed.community),
    tlv(0xa2, pduContent),
  ]));
}

// ─── UDP server ───────────────────────────────────────────────────────────────

const server = dgram.createSocket('udp4');

server.on('message', (msg, rinfo) => {
  const parsed = parsePacket(msg);
  if (!parsed) return;
  const response = buildResponse(parsed);
  server.send(response, rinfo.port, rinfo.address);
});

server.on('error', (err) => { console.error('UDP error:', err); });

server.bind(PORT, () => {
  console.log(`SNMP mock agent listening on UDP :${PORT}`);
  console.log(`cpu=${s.cpuLoad}%  mem=${s.memUsed}/${s.memTotal}MB  disk=${Math.round(s.diskUsed/s.diskSize*100)}%`);
});
