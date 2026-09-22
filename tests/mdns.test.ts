// tests/mdns.test.ts — the mDNS querier: DNS wire parsing (compression
// included), the browser's instance table (up/refresh/goodbye/expiry, link-
// local rejection, query emission), and the no-multicast error path. A fake
// socket drives packets deterministically — no multicast in the gate.
import { assert, assertEquals } from '@std/assert';
import {
  createMdnsBrowser,
  parseA,
  parseDnsMessage,
  parsePtrName,
  parseSrv,
  parseTxt,
  type UdpSocketLike,
} from '../src/mdns.ts';
import { airplayAnswer, MsgBuilder, ptrOnlyAnswer } from './mdns-builder.ts';
import os from 'node:os';

const INSTANCE = 'A4B2C1D2E3F4@Kitchen ATV._raop._tcp.local';
const HOST = 'kitchen-atv.local';
const TYPE_A = 1;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_SRV = 33;

function ipv4Addresses(): string[] {
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
}

function readQname(
  msg: Uint8Array,
  offset: number,
): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let end = -1;
  const decoder = new TextDecoder();
  for (;;) {
    const len = msg[pos];
    if ((len & 0xc0) === 0xc0) {
      if (end === -1) end = pos + 2;
      pos = ((len & 0x3f) << 8) | msg[pos + 1];
      continue;
    }
    if (len === 0) {
      if (end === -1) end = pos + 1;
      return { name: labels.join('.'), next: end };
    }
    labels.push(decoder.decode(msg.subarray(pos + 1, pos + 1 + len)));
    pos += 1 + len;
  }
}

function parseQuestions(
  msg: Uint8Array,
): { name: string; type: number }[] {
  const view = new DataView(msg.buffer, msg.byteOffset, msg.length);
  const qd = view.getUint16(4);
  let offset = 12;
  const out: { name: string; type: number }[] = [];
  for (let i = 0; i < qd; i++) {
    const q = readQname(msg, offset);
    out.push({ name: q.name, type: view.getUint16(q.next) });
    offset = q.next + 4;
  }
  return out;
}

// --------------------------------------------------------------------------
// Parser tests

Deno.test('parser: full AirPlay answer (compression everywhere)', () => {
  const msg = airplayAnswer({
    instance: INSTANCE,
    host: 'kitchen-atv.local',
    address: [192, 168, 1, 50],
  });
  const records = parseDnsMessage(msg);
  assert(records !== null);
  assertEquals(records.length, 4);

  assertEquals(parsePtrName(msg, records[0]), INSTANCE);

  const srv = parseSrv(msg, records[2]);
  assert(srv !== null);
  assertEquals(srv.port, 7000);
  assertEquals(srv.target, 'kitchen-atv.local');

  assertEquals(parseTxt(records[1]), {
    tp: 'UDP',
    am: 'AppleTV3,1',
    ek: '1',
    sf: '0x200',
  });

  assertEquals(parseA(records[3]), '192.168.1.50');
});

Deno.test('parser: truncation and compression loops return null, never throw', () => {
  const good = airplayAnswer({
    instance: INSTANCE,
    host: 'kitchen-atv.local',
    address: [192, 168, 1, 50],
  });
  assertEquals(parseDnsMessage(good.subarray(0, 20)), null);
  assertEquals(parseDnsMessage(good.subarray(0, good.length - 2)), null);
  // A name that pointer-loops onto itself.
  assertEquals(
    parseDnsMessage(
      new Uint8Array([
        0,
        0,
        0x84,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0xc0,
        0x0c,
        0,
        12,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
      ]),
    ),
    null,
  );
});

// --------------------------------------------------------------------------
// Fake socket + browser tests

class FakeSocket implements UdpSocketLike {
  sent: { buf: Uint8Array; port: number; address: string }[] = [];
  memberships: { address: string; iface?: string }[] = [];
  closed = false;
  failMembership = false;
  private listener:
    | ((msg: Uint8Array, rinfo: { address: string; port: number }) => void)
    | null = null;
  bind(_port: number, cb?: () => void) {
    cb?.();
  }
  addMembership(address: string, iface?: string) {
    if (this.failMembership) throw new Error('no multicast route');
    this.memberships.push(
      iface === undefined ? { address } : { address, iface },
    );
  }
  setMulticastTTL() {}
  send(buf: Uint8Array, port: number, address: string) {
    this.sent.push({ buf, port, address });
  }
  on(
    _event: 'message',
    fn: (msg: Uint8Array, rinfo: { address: string; port: number }) => void,
  ) {
    this.listener = fn;
  }
  receive(msg: Uint8Array) {
    this.listener?.(msg, { address: '192.168.1.50', port: 5353 });
  }
  close() {
    this.closed = true;
  }
}

function setup(socket = new FakeSocket()) {
  const events: ['up' | 'down', string][] = [];
  const errors: unknown[] = [];
  const services = new Map<string, {
    host: string;
    port: number;
    address: string;
    txt: Record<string, string>;
  }>();
  const browser = createMdnsBrowser({
    type: '_raop._tcp',
    socket,
    queryIntervalMs: 60_000,
    sweepIntervalMs: 50,
    onService(event, svc) {
      events.push([event, svc.name]);
      if (event === 'up') {
        services.set(svc.name, {
          host: svc.host,
          port: svc.port,
          address: svc.address,
          txt: svc.txt,
        });
      }
    },
    onError(err) {
      errors.push(err);
    },
  });
  return { browser, socket, events, errors, services };
}

Deno.test('browser: sends a standing PTR query and joins the group', () => {
  const { browser, socket } = setup();
  try {
    const ifaces = ipv4Addresses();
    assertEquals(
      socket.memberships,
      ifaces.length === 0
        ? [{ address: '224.0.0.251' }]
        : ifaces.map((iface) => ({ address: '224.0.0.251', iface })),
    );
    assert(socket.sent.length >= 1);
    const query = socket.sent[0];
    assertEquals(query.port, 5353);
    assertEquals(query.address, '224.0.0.251');
    // qdcount 1, qname _raop._tcp.local, PTR, IN.
    const q = query.buf;
    assertEquals(q[5], 1);
    const expectedQname = [
      5,
      ...[...'_raop'].map((c) => c.charCodeAt(0)),
      4,
      ...[...'_tcp'].map((c) => c.charCodeAt(0)),
      5,
      ...[...'local'].map((c) => c.charCodeAt(0)),
      0,
    ];
    assertEquals(
      [...q.subarray(12, 12 + expectedQname.length)],
      expectedQname,
    );
    assertEquals(q[12 + expectedQname.length], 0); // qtype hi
    assertEquals(q[12 + expectedQname.length + 1], 0x0c); // qtype lo (PTR)
  } finally {
    browser.close();
  }
});

Deno.test('browser: up on a complete answer, deduped refresh, change re-ups', () => {
  const { browser, socket, events, services } = setup();
  try {
    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: 'kitchen-atv.local',
      address: [192, 168, 1, 50],
    }));
    assertEquals(events, [['up', INSTANCE]]);
    const svc = services.get(INSTANCE)!;
    assertEquals(svc.host, 'kitchen-atv.local');
    assertEquals(svc.port, 7000);
    assertEquals(svc.address, '192.168.1.50');
    assertEquals(svc.txt.am, 'AppleTV3,1');
    assertEquals(svc.txt.ek, '1');

    // A refresh with identical data is not a new 'up'.
    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: 'kitchen-atv.local',
      address: [192, 168, 1, 50],
    }));
    assertEquals(events.length, 1);

    // A change (different port) re-announces.
    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: 'kitchen-atv.local',
      address: [192, 168, 1, 50],
      port: 7001,
    }));
    assertEquals(events.length, 2);
    assertEquals(events[1], ['up', INSTANCE]);
    assertEquals(services.get(INSTANCE)!.port, 7001);
  } finally {
    browser.close();
  }
});

Deno.test('browser: goodbye (TTL 0) and TTL expiry emit down', async () => {
  const { browser, socket, events } = setup();
  try {
    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: 'kitchen-atv.local',
      address: [192, 168, 1, 50],
    }));
    assertEquals(events.length, 1);

    const bye = new MsgBuilder();
    bye.header(1);
    bye.record('_raop._tcp.local', 12, 0, (bb) => bb.name(INSTANCE));
    socket.receive(bye.build());
    assertEquals(events[1], ['down', INSTANCE]);

    // And a quiet device whose TTL runs out.
    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: 'kitchen-atv.local',
      address: [192, 168, 1, 50],
      ttl: 1,
    }));
    assertEquals(events.length, 3); // the second up
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assertEquals(events[events.length - 1], ['down', INSTANCE]);
  } finally {
    browser.close();
  }
});

Deno.test('browser: link-local-only devices never come up', () => {
  const { browser, socket, events } = setup();
  try {
    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: 'kitchen-atv.local',
      address: [169, 254, 1, 1],
    }));
    assertEquals(events, []);
  } finally {
    browser.close();
  }
});

Deno.test('browser: no multicast route is one error, not a crash', () => {
  const socket = new FakeSocket();
  socket.failMembership = true;
  const { browser, errors } = setup(socket);
  try {
    assertEquals(errors.length, 1);
    assertEquals((errors[0] as Error).message, 'no multicast route');
  } finally {
    browser.close();
  }
});

Deno.test('browser: PTR-only triggers SRV+TXT follow-up, then up', () => {
  const { browser, socket, events, services } = setup();
  try {
    const before = socket.sent.length;
    socket.receive(ptrOnlyAnswer(INSTANCE));
    const followUps = socket.sent.slice(before);
    assert(
      followUps.some((s) => {
        const qs = parseQuestions(s.buf);
        return s.address === '224.0.0.251' && s.port === 5353 &&
          qs.some((q) => q.name === INSTANCE && q.type === TYPE_SRV) &&
          qs.some((q) => q.name === INSTANCE && q.type === TYPE_TXT);
      }),
      'expected multicast SRV+TXT questions for the instance',
    );
    assertEquals(events, []);

    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: HOST,
      address: [192, 168, 1, 50],
    }));
    assertEquals(events, [['up', INSTANCE]]);
    assertEquals(services.get(INSTANCE)!.address, '192.168.1.50');
  } finally {
    browser.close();
  }
});

Deno.test('browser: SRV without A triggers A+AAAA follow-up, then up', () => {
  const { browser, socket, events } = setup();
  try {
    const before = socket.sent.length;
    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: HOST,
      address: [192, 168, 1, 50],
      omitA: true,
    }));
    const followUps = socket.sent.slice(before);
    assert(
      followUps.some((s) => {
        const qs = parseQuestions(s.buf);
        return s.address === '224.0.0.251' && s.port === 5353 &&
          qs.some((q) => q.name === HOST && q.type === TYPE_A) &&
          qs.some((q) => q.name === HOST && q.type === TYPE_AAAA);
      }),
      'expected multicast A+AAAA questions for the SRV target',
    );
    assertEquals(events, []);

    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: HOST,
      address: [192, 168, 1, 50],
    }));
    assertEquals(events, [['up', INSTANCE]]);
  } finally {
    browser.close();
  }
});

Deno.test('browser: AAAA-only logs no usable v4 and stays down', () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.join(' '));
  const { browser, socket, events } = setup();
  try {
    socket.receive(airplayAnswer({
      instance: INSTANCE,
      host: HOST,
      address: [192, 168, 1, 50],
      omitA: true,
      aaaa: [0x20, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    }));
    assertEquals(events, []);
    assert(
      warns.some((w) => w.includes('no usable v4')),
      `missing no usable v4 log: ${warns.join(' | ')}`,
    );
  } finally {
    console.warn = orig;
    browser.close();
  }
});
