// src/mdns.ts — a small mDNS QUERIER (service discovery browser) over
// node:dgram — Deno 2's UDP path (Deno.listenDatagram was removed). Querier
// role only: standing PTR query out, answers/announcements in. No responder
// role (no answering others' queries, no probing, no announcing).
//
// createMdnsBrowser({ type, onService }) binds UDP 5353, joins 224.0.0.251
// on every non-internal IPv4 iface, queries for `type` at start and on a
// refresh interval, tracks per-instance records (PTR/SRV/TXT/A) with TTLs,
// and emits 'up' when an instance becomes complete (SRV + usable v4) or its
// address/port/host/txt changes, 'down' on goodbye (TTL 0) or TTL expiry.
// Incomplete PTRs get follow-up SRV+TXT (and A/AAAA once the SRV target is
// known), throttled to one burst per instance per 1 s. IPv4 only; link-local
// A records don't count as usable. AAAA is parsed; v6-only stays down with a
// `no usable v4` log. The socket is injectable so tests drive packets
// deterministically.
import dgram from 'node:dgram';
import os from 'node:os';

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const QUERY_INTERVAL_MS = 60_000;
const SWEEP_INTERVAL_MS = 10_000;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_SRV = 33;
const FOLLOW_UP_MS = 1000;

export interface MdnsService {
  /** Instance name (FQDN, e.g. "A4B2C1@Kitchen ATV._raop._tcp.local"). */
  name: string;
  /** SRV target hostname. */
  host: string;
  port: number;
  /** First usable v4 address (never link-local). */
  address: string;
  txt: Record<string, string>;
  ttlMs: number;
}

export interface UdpSocketLike {
  bind(port: number, cb?: () => void): void;
  addMembership(address: string, iface?: string): void;
  setMulticastTTL(ttl: number): void;
  send(buf: Uint8Array, port: number, address: string): void;
  on(
    event: 'message',
    fn: (msg: Uint8Array, rinfo: { address: string; port: number }) => void,
  ): void;
  close(): void;
}

export interface MdnsBrowserOptions {
  /** Service type to browse, e.g. '_raop._tcp'. */
  type: string;
  onService(event: 'up' | 'down', service: MdnsService): void;
  queryIntervalMs?: number;
  sweepIntervalMs?: number;
  socket?: UdpSocketLike;
  /** Called once when the socket/group setup fails (e.g. no multicast
   * route — bridged Docker). The browser is dead afterwards. */
  onError?: (err: unknown) => void;
}

// --------------------------------------------------------------------------
// DNS wire format (queries and answers — the subset discovery needs)

const decoder = new TextDecoder();

/** Read a possibly-compressed DNS name. Null on malformed (loop/truncated). */
function readName(
  msg: Uint8Array,
  offset: number,
): { name: string; next: number } | null {
  const labels: string[] = [];
  let pos = offset;
  let end = -1;
  for (let hops = 0; hops < 128; hops++) {
    if (pos >= msg.length) return null;
    const len = msg[pos];
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= msg.length) return null;
      if (end === -1) end = pos + 2;
      pos = ((len & 0x3f) << 8) | msg[pos + 1];
      continue;
    }
    if (len === 0) {
      if (end === -1) end = pos + 1;
      return { name: labels.join('.'), next: end };
    }
    if (pos + 1 + len > msg.length) return null;
    labels.push(decoder.decode(msg.subarray(pos + 1, pos + 1 + len)));
    pos += 1 + len;
  }
  return null; // compression loop
}

export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  rdata: Uint8Array;
}

/** Parse a DNS message's answer/authority/additional records (questions are
 * skipped). Null on any truncation/malformation — never throws. */
export function parseDnsMessage(msg: Uint8Array): DnsRecord[] | null {
  if (msg.length < 12) return null;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.length);
  const qd = view.getUint16(4);
  const an = view.getUint16(6);
  const ns = view.getUint16(8);
  const ar = view.getUint16(10);
  let offset = 12;
  for (let i = 0; i < qd; i++) {
    const q = readName(msg, offset);
    if (q === null) return null;
    offset = q.next + 4;
    if (offset > msg.length) return null;
  }
  const records: DnsRecord[] = [];
  for (let i = 0; i < an + ns + ar; i++) {
    const r = readName(msg, offset);
    if (r === null) return null;
    offset = r.next;
    if (offset + 10 > msg.length) return null;
    const type = view.getUint16(offset);
    const ttl = view.getUint32(offset + 4);
    const rdlen = view.getUint16(offset + 8);
    offset += 10;
    if (offset + rdlen > msg.length) return null;
    records.push({
      name: r.name,
      type,
      ttl,
      rdata: msg.subarray(offset, offset + rdlen),
    });
    offset += rdlen;
  }
  return records;
}

/** PTR rdata is a (compressible) name. */
export function parsePtrName(
  msg: Uint8Array,
  record: DnsRecord,
): string | null {
  const rdataOffset = record.rdata.byteOffset - msg.byteOffset;
  const r = readName(msg, rdataOffset);
  return r === null ? null : r.name;
}

/** SRV rdata: priority(2) weight(2) port(2) target(name). */
export function parseSrv(
  msg: Uint8Array,
  record: DnsRecord,
): { port: number; target: string } | null {
  if (record.rdata.length < 6) return null;
  const view = new DataView(msg.buffer, msg.byteOffset, msg.length);
  const rdataOffset = record.rdata.byteOffset - msg.byteOffset;
  const port = view.getUint16(rdataOffset + 4);
  const target = readName(msg, rdataOffset + 6);
  return target === null ? null : { port, target: target.name };
}

/** TXT rdata: <len:1><bytes> chunks of "key=value" (bare "key" has no =). */
export function parseTxt(record: DnsRecord): Record<string, string> {
  const txt: Record<string, string> = {};
  let offset = 0;
  while (offset < record.rdata.length) {
    const len = record.rdata[offset++];
    if (offset + len > record.rdata.length) break;
    const entry = decoder.decode(record.rdata.subarray(offset, offset + len));
    offset += len;
    const eq = entry.indexOf('=');
    if (eq > 0) txt[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return txt;
}

/** A rdata: 4 bytes → dotted quad. */
export function parseA(record: DnsRecord): string | null {
  if (record.rdata.length !== 4) return null;
  return [...record.rdata].join('.');
}

// --------------------------------------------------------------------------

function encodeQuery(name: string, types: number[]): Uint8Array {
  const parts = name.replace(/\.+$/, '').split('.').filter((p) => p.length > 0);
  const qnameLen = parts.reduce((n, p) => n + 1 + p.length, 1);
  const rest = types.length === 0 ? 0 : 4 + (types.length - 1) * 6;
  const out = new Uint8Array(12 + (types.length === 0 ? 0 : qnameLen + rest));
  const view = new DataView(out.buffer);
  view.setUint16(4, types.length);
  if (types.length === 0) return out;
  let offset = 12;
  for (const part of parts) {
    out[offset++] = part.length;
    for (let i = 0; i < part.length; i++) out[offset++] = part.charCodeAt(i);
  }
  offset++; // root 0
  view.setUint16(offset, types[0]);
  view.setUint16(offset + 2, 1); // IN
  offset += 4;
  for (let i = 1; i < types.length; i++) {
    out[offset] = 0xc0;
    out[offset + 1] = 12;
    view.setUint16(offset + 2, types[i]);
    view.setUint16(offset + 4, 1);
    offset += 6;
  }
  return out;
}

function ipv4Addresses(): string[] {
  try {
    const out: string[] = [];
    for (const addrs of Object.values(os.networkInterfaces())) {
      if (addrs === undefined) continue;
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) {
          out.push(a.address);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

const isLinkLocal = (address: string) => address.startsWith('169.254.');

interface Instance {
  name: string;
  host: string | null;
  port: number | null;
  address: string | null;
  txt: Record<string, string>;
  gotTxt: boolean;
  sawAaaa: boolean;
  loggedNoV4: boolean;
  lastFollowUpAt: number;
  expiresAt: number;
  /** Signature of the last 'up' we announced (dedupe: refresh ≠ re-up). */
  upKey: string | null;
}

export interface MdnsBrowser {
  close(): void;
}

export function createMdnsBrowser(opts: MdnsBrowserOptions): MdnsBrowser {
  const typeName = `${opts.type}.local`;
  const instances = new Map<string, Instance>();
  let dead = false;

  const fail = (err: unknown) => {
    if (dead) return;
    dead = true;
    opts.onError?.(err);
  };

  let socket: UdpSocketLike;
  try {
    socket = opts.socket ?? dgram.createSocket({
      type: 'udp4',
      reuseAddr: true,
    }) as unknown as UdpSocketLike;
  } catch (err) {
    fail(err);
    return { close() {} };
  }

  const emit = (instance: Instance) => {
    if (
      instance.host === null || instance.port === null ||
      instance.address === null
    ) return; // not complete yet
    const key = `${instance.host}|${instance.port}|${instance.address}|` +
      JSON.stringify(instance.txt);
    if (instance.upKey === key) return; // refresh, nothing changed
    instance.upKey = key;
    opts.onService('up', {
      name: instance.name,
      host: instance.host,
      port: instance.port,
      address: instance.address,
      txt: { ...instance.txt },
      ttlMs: Math.max(0, instance.expiresAt - Date.now()),
    });
  };

  const drop = (key: string, instance: Instance) => {
    instances.delete(key);
    if (
      instance.upKey !== null && instance.host !== null &&
      instance.port !== null && instance.address !== null
    ) {
      opts.onService('down', {
        name: instance.name,
        host: instance.host,
        port: instance.port,
        address: instance.address,
        txt: { ...instance.txt },
        ttlMs: 0,
      });
    }
  };

  const sendEncoded = (name: string, types: number[], dest: string) => {
    if (dead) return;
    try {
      socket.send(encodeQuery(name, types), MDNS_PORT, dest);
    } catch { /* transient send failure — the interval retries */ }
  };

  const maybeFollowUp = (instance: Instance, dest = MDNS_GROUP) => {
    const missingSrv = instance.host === null || instance.port === null;
    const missingTxt = !instance.gotTxt;
    const missingA = instance.address === null;
    if (!missingSrv && !missingTxt && !missingA) return;
    const now = Date.now();
    if (now - instance.lastFollowUpAt < FOLLOW_UP_MS) return;
    instance.lastFollowUpAt = now;
    if (missingSrv || missingTxt) {
      sendEncoded(instance.name, [TYPE_SRV, TYPE_TXT], dest);
    }
    if (!missingSrv && missingA) {
      sendEncoded(instance.host!, [TYPE_A, TYPE_AAAA], dest);
    }
  };

  const handlePacket = (msg: Uint8Array) => {
    // Only responses/announcements (qr bit set, flags byte 2 bit 7).
    if (msg.length < 12 || (msg[2] & 0x80) === 0) return;
    const records = parseDnsMessage(msg);
    if (records === null) return;
    const now = Date.now();

    // First pass: PTR — discover instances of our type.
    for (const record of records) {
      if (record.type !== TYPE_PTR) continue;
      const ptrName = parsePtrName(msg, record);
      if (ptrName === null || !ptrName.endsWith(`.${typeName}`)) continue;
      const key = ptrName.toLowerCase();
      let instance = instances.get(key);
      if (record.ttl === 0) {
        if (instance !== undefined) drop(key, instance);
        continue;
      }
      if (instance === undefined) {
        instance = {
          name: ptrName,
          host: null,
          port: null,
          address: null,
          txt: {},
          gotTxt: false,
          sawAaaa: false,
          loggedNoV4: false,
          lastFollowUpAt: 0,
          expiresAt: 0,
          upKey: null,
        };
        instances.set(key, instance);
      }
      instance.expiresAt = now + record.ttl * 1000;
    }

    // Second pass: SRV/TXT/A flesh the instances out.
    for (const record of records) {
      if (record.ttl === 0) continue; // goodbye handled above
      const key = record.name.toLowerCase();
      const instance = instances.get(key);
      if (record.type === TYPE_SRV && instance !== undefined) {
        const srv = parseSrv(msg, record);
        if (srv === null) continue;
        instance.host = srv.target.replace(/\.+$/, '');
        instance.port = srv.port;
        instance.expiresAt = now + record.ttl * 1000;
      } else if (record.type === TYPE_TXT && instance !== undefined) {
        instance.txt = parseTxt(record);
        instance.gotTxt = true;
        instance.expiresAt = now + record.ttl * 1000;
      } else if (record.type === TYPE_A) {
        // The A record's name is the SRV target's hostname, not the instance.
        const address = parseA(record);
        if (address === null || isLinkLocal(address)) continue;
        for (const inst of instances.values()) {
          if (
            inst.host !== null &&
            inst.host.toLowerCase() ===
              record.name.replace(/\.+$/, '').toLowerCase()
          ) {
            inst.address = address;
            inst.expiresAt = now + record.ttl * 1000;
          }
        }
      } else if (record.type === TYPE_AAAA) {
        const hostName = record.name.replace(/\.+$/, '').toLowerCase();
        for (const inst of instances.values()) {
          if (inst.host !== null && inst.host.toLowerCase() === hostName) {
            inst.sawAaaa = true;
          }
        }
      }
    }

    for (const instance of instances.values()) {
      emit(instance);
      if (
        instance.host !== null && instance.address === null &&
        instance.sawAaaa && !instance.loggedNoV4
      ) {
        instance.loggedNoV4 = true;
        console.warn(`[melofon] mdns: ${instance.name} no usable v4`);
      }
      maybeFollowUp(instance);
    }
  };

  try {
    socket.on('message', (msg) => handlePacket(msg));
    socket.bind(MDNS_PORT, () => {
      try {
        const ifaces = ipv4Addresses();
        let joined = false;
        let lastErr: unknown;
        if (ifaces.length === 0) {
          socket.addMembership(MDNS_GROUP);
          joined = true;
        } else {
          for (const iface of ifaces) {
            try {
              socket.addMembership(MDNS_GROUP, iface);
              joined = true;
            } catch (err) {
              lastErr = err;
            }
          }
        }
        if (!joined) {
          fail(lastErr);
          return;
        }
        socket.setMulticastTTL(255);
      } catch (err) {
        fail(err);
      }
    });
  } catch (err) {
    fail(err);
    return { close() {} };
  }

  const sendQuery = () => sendEncoded(typeName, [TYPE_PTR], MDNS_GROUP);
  sendQuery();
  const queryTimer = setInterval(
    sendQuery,
    opts.queryIntervalMs ?? QUERY_INTERVAL_MS,
  );
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, instance] of [...instances]) {
      if (instance.expiresAt <= now) drop(key, instance);
    }
  }, opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS);

  return {
    close() {
      dead = true;
      clearInterval(queryTimer);
      clearInterval(sweepTimer);
      try {
        socket.close();
      } catch { /* already closed */ }
    },
  };
}
