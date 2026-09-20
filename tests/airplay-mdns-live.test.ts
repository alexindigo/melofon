// tests/airplay-mdns-live.test.ts — the mDNS querier against real multicast:
// an in-process fake device answers our standing query over 224.0.0.251:5353
// (the same shape the household LAN answered in development). Gated on the
// environment supporting multicast — skipped where it doesn't (some CI).
// Real LAN devices may also answer; assertions only cover our fake instance.
import { assert } from '@std/assert';
import dgram from 'node:dgram';
import { createMdnsBrowser, type MdnsService } from '../src/mdns.ts';
import { airplayAnswer } from './mdns-builder.ts';

const INSTANCE = 'DEADBEEFCAFE01@Test Speaker MDNS._raop._tcp.local';

async function multicastAvailable(): Promise<boolean> {
  try {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.bind(5353, () => resolve());
    });
    s.addMembership('224.0.0.251');
    s.close();
    return true;
  } catch {
    return false;
  }
}

/** Fake device: answers _raop._tcp PTR queries with a canned AirPlay ad. */
async function startResponder() {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise<void>((resolve) => socket.bind(5353, () => resolve()));
  socket.addMembership('224.0.0.251');
  const answer = airplayAnswer({
    instance: INSTANCE,
    host: 'fake-speaker.local',
    address: [203, 0, 113, 7],
  });
  socket.on('message', (msg, rinfo) => {
    // Only answer real queries (qr bit clear) that mention _raop.
    if (msg.length > 12 && (msg[2] & 0x80) === 0 && msg.includes(0x5f)) {
      socket.send(answer, rinfo.port, rinfo.address);
    }
  });
  return {
    close() {
      try {
        socket.close();
      } catch { /* already closed */ }
    },
  };
}

const CAN_MULTICAST = await multicastAvailable();

Deno.test({
  name: 'live multicast: a fake device answers the standing query',
  ignore: !CAN_MULTICAST,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const responder = await startResponder();
    const found: MdnsService[] = [];
    const browser = createMdnsBrowser({
      type: '_raop._tcp',
      queryIntervalMs: 500,
      sweepIntervalMs: 10_000,
      onService: (event, svc) => {
        if (event === 'up' && svc.name === INSTANCE) found.push(svc);
      },
    });
    try {
      const deadline = performance.now() + 10_000;
      while (found.length === 0) {
        if (performance.now() > deadline) {
          throw new Error('timed out waiting for the fake device');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(
        found[0].address === '203.0.113.7',
        `address: ${found[0].address}`,
      );
      assert(found[0].port === 7000, `port: ${found[0].port}`);
    } finally {
      browser.close();
      responder.close();
    }
  },
});
