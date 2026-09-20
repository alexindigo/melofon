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

// --------------------------------------------------------------------------
// Canned-packet builder (compresses suffixes automatically, like real devices)

class MsgBuilder {
  bytes: number[] = [];
  private offsets = new Map<string, number>();

  header(ancount: number) {
    this.bytes.push(
      0,
      0, // id
      0x84,
      0x00, // flags: response, authoritative
      0,
      0, // qd
      (ancount >> 8) & 0xff,
      ancount & 0xff,
      0,
      0,
      0,
      0, // ns, ar
    );
  }

  name(fqdn: string) {
    const labels = fqdn.split('.');
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.');
      const existing = this.offsets.get(suffix);
      if (existing !== undefined) {
        this.bytes.push(0xc0 | (existing >> 8), existing & 0xff);
        return;
      }
      this.offsets.set(suffix, this.bytes.length);
      this.bytes.push(
        labels[i].length,
        ...[...labels[i]].map((c) => c.charCodeAt(0)),
      );
    }
    this.bytes.push(0);
  }

  u16(v: number) {
    this.bytes.push((v >> 8) & 0xff, v & 0xff);
  }

  u32(v: number) {
    this.bytes.push(
      (v >>> 24) & 0xff,
      (v >>> 16) & 0xff,
      (v >>> 8) & 0xff,
      v & 0xff,
    );
  }

  record(
    fqdn: string,
    type: number,
    ttl: number,
    writeRdata: (b: MsgBuilder) => void,
  ) {
    this.name(fqdn);
    this.u16(type);
    this.u16(1); // IN
    this.u32(ttl);
    const lenPos = this.bytes.length;
    this.u16(0);
    const start = this.bytes.length;
    writeRdata(this);
    const len = this.bytes.length - start;
    this.bytes[lenPos] = (len >> 8) & 0xff;
    this.bytes[lenPos + 1] = len & 0xff;
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

const INSTANCE = 'A4B2C1D2E3F4@Kitchen ATV._raop._tcp.local';

function airplayAnswer(opts: { ttl?: number; address?: number[] } = {}) {
  const ttl = opts.ttl ?? 120;
  const address = opts.address ?? [192, 168, 1, 50];
  const b = new MsgBuilder();
  b.header(4);
  b.record('_raop._tcp.local', 12, ttl, (bb) => bb.name(INSTANCE));
  b.record(INSTANCE, 16, ttl, (bb) => {
    for (const kv of ['tp=UDP', 'am=AppleTV3,1', 'ek=1', 'sf=0x200']) {
      bb.bytes.push(kv.length, ...[...kv].map((c) => c.charCodeAt(0)));
    }
  });
  b.record(INSTANCE, 33, ttl, (bb) => {
    bb.u16(0);
    bb.u16(0);
    bb.u16(7000);
    bb.name('kitchen-atv.local');
  });
  b.record('kitchen-atv.local', 1, ttl, (bb) => bb.bytes.push(...address));
  return b.build();
}

// --------------------------------------------------------------------------
// Parser tests

Deno.test('parser: full AirPlay answer (compression everywhere)', () => {
  const msg = airplayAnswer();
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
  const good = airplayAnswer();
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
  memberships: string[] = [];
  closed = false;
  failMembership = false;
  private listener:
    | ((msg: Uint8Array, rinfo: { address: string; port: number }) => void)
    | null = null;
  bind(_port: number, cb?: () => void) {
    cb?.();
  }
  addMembership(address: string) {
    if (this.failMembership) throw new Error('no multicast route');
    this.memberships.push(address);
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
    assertEquals(socket.memberships, ['224.0.0.251']);
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
    assertEquals([...q.subarray(12, 12 + expectedQname.length)], expectedQname);
    assertEquals(q[12 + expectedQname.length], 0); // qtype hi
    assertEquals(q[12 + expectedQname.length + 1], 0x0c); // qtype lo (PTR)
  } finally {
    browser.close();
  }
});

Deno.test('browser: up on a complete answer, deduped refresh, change re-ups', () => {
  const { browser, socket, events, services } = setup();
  try {
    socket.receive(airplayAnswer());
    assertEquals(events, [['up', INSTANCE]]);
    const svc = services.get(INSTANCE)!;
    assertEquals(svc.host, 'kitchen-atv.local');
    assertEquals(svc.port, 7000);
    assertEquals(svc.address, '192.168.1.50');
    assertEquals(svc.txt.am, 'AppleTV3,1');
    assertEquals(svc.txt.ek, '1');

    // A refresh with identical data is not a new 'up'.
    socket.receive(airplayAnswer());
    assertEquals(events.length, 1);

    // A change (different port) re-announces.
    const changed = new MsgBuilder();
    changed.header(4);
    changed.record('_raop._tcp.local', 12, 120, (bb) => bb.name(INSTANCE));
    changed.record(INSTANCE, 16, 120, () => {});
    changed.record(INSTANCE, 33, 120, (bb) => {
      bb.u16(0);
      bb.u16(0);
      bb.u16(7001);
      bb.name('kitchen-atv.local');
    });
    changed.record(
      'kitchen-atv.local',
      1,
      120,
      (bb) => bb.bytes.push(192, 168, 1, 50),
    );
    socket.receive(changed.build());
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
    socket.receive(airplayAnswer());
    assertEquals(events.length, 1);

    const bye = new MsgBuilder();
    bye.header(1);
    bye.record('_raop._tcp.local', 12, 0, (bb) => bb.name(INSTANCE));
    socket.receive(bye.build());
    assertEquals(events[1], ['down', INSTANCE]);

    // And a quiet device whose TTL runs out.
    socket.receive(airplayAnswer({ ttl: 1 }));
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
    socket.receive(airplayAnswer({ address: [169, 254, 1, 1] }));
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
