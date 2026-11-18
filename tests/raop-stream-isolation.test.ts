import { assert, assertEquals } from '@std/assert';
import { createSocket } from 'node:dgram';
import type { FakeRaopSession } from './helpers/fake-raop.ts';
import {
  libraryProof,
  nativeStream,
  pcm,
  progress,
  rendered,
  startFakeRaop,
  titles,
  until,
} from './helpers/raop-isolation.ts';

// Arrival duplicates remain in wire evidence; decode each original packet once.
// The independently scheduled consumer also deduplicates the actual wire.
function deduplicated(session: FakeRaopSession): FakeRaopSession {
  const packets = new Map<number, Uint8Array>();
  for (const event of session.wire) {
    if (event.kind !== 'audio') continue;
    const sequence = new DataView(event.data.buffer, event.data.byteOffset)
      .getUint16(2);
    if (!packets.has(sequence)) packets.set(sequence, event.data.subarray(12));
  }
  return { ...session, audioPayloads: [...packets.values()] };
}
function audio(session: FakeRaopSession) {
  return session.wire.flatMap((event) =>
    event.kind === 'audio' ? [event.data] : []
  );
}
function retransmission(actual: Uint8Array | undefined, original: Uint8Array) {
  const expected = original.slice();
  // The initial-send marker is per attachment, not part of the cached packet.
  expected[1] &= 0x7f;
  assertEquals(actual, expected);
}
const routingName =
  'RAOP isolation: same-IP endpoints, overlapping sequences and canceled caches route only to their owner';
Deno.test({
  name: routingName,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!Deno.env.get('RAOP_ROUTING_CHILD')) {
      const directory = await Deno.makeTempDir({ prefix: 'raop-routing-' });
      const helper = new URL('../helper/raop/', import.meta.url).pathname;
      const interposer = `${directory}/routing.so`;
      const build = await new Deno.Command('cc', {
        args: [
          '-shared',
          '-fPIC',
          '-I',
          `${helper}stub`,
          '-I',
          `${helper}vendor`,
          '-o',
          interposer,
          `${helper}test/progress-faultinject.c`,
          '-ldl',
        ],
      }).output();
      assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
      const child = await new Deno.Command(Deno.execPath(), {
        args: [
          'test',
          '--frozen',
          '--cached-only',
          '--node-modules-dir=manual',
          '-A',
          '--filter',
          routingName,
          new URL(import.meta.url).pathname,
        ],
        env: {
          LD_PRELOAD: interposer,
          RAOP_PROGRESS_WRAP: '1',
          RAOP_ROUTING_CHILD: '1',
        },
      }).output();
      await Deno.writeFile(`${directory}/child.stdout`, child.stdout);
      await Deno.writeFile(`${directory}/child.stderr`, child.stderr);
      const stdout = new TextDecoder().decode(child.stdout);
      assertEquals(
        child.code,
        0,
        stdout + new TextDecoder().decode(child.stderr),
      );
      assert(/1 passed.*0 failed/.test(stdout));
      for (const line of stdout.split('\n')) {
        if (line.startsWith('isolation native library:')) console.log(line);
      }
      return;
    }
    const a = nativeStream(), b = nativeStream();
    const first = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const second = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const third = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const spoof = createSocket('udp4');
    try {
      assertEquals(await b.metadata('B', 'B', 0, 1000), 0);
      assertEquals(await a.metadata('A', 'A', 0, 1000), 0);
      await a.attach(first);
      await a.attach(second);
      a.write(pcm(704, 10));
      await Promise.all([
        rendered(first, pcm(704, 10)),
        rendered(second, pcm(704, 10)),
      ]);
      const one = first.sessions[0], two = second.sessions[0];
      assertEquals(one.rtpSequences, [65534, 65535]);
      assertEquals(two.rtpSequences, one.rtpSequences);
      assertEquals(one.endpoints!.senderControl, two.endpoints!.senderControl);
      const original = audio(one).map((p) => p.slice());
      first.requestRetransmit(one.id, 65534);
      await until('first endpoint retransmit', () => one.audioPackets >= 3);
      retransmission(audio(one).at(-1), original[0]);
      assertEquals(two.audioPackets, 2);
      second.requestRetransmit(two.id, 65535);
      await until('second endpoint retransmit', () => two.audioPackets >= 3);
      retransmission(audio(two).at(-1), original[1]);
      assertEquals(one.audioPackets, 3);
      // Queue an unknown source port before a valid request on the same service.
      const request = new Uint8Array([0x80, 0xd5, 0, 1, 0xff, 0xfe, 0, 1]);
      await new Promise<void>((resolve, reject) =>
        spoof.send(
          request,
          one.endpoints!.senderControl!.port,
          '127.0.0.1',
          (error) => error ? reject(error) : resolve(),
        )
      );
      first.requestRetransmit(one.id, 65535);
      await until('valid request behind spoof', () => one.audioPackets >= 4);
      assertEquals([one.audioPackets, two.audioPackets], [4, 3]);
      retransmission(audio(one).at(-1), original[1]);
      await a.cancel();
      first.requestRetransmit(one.id, 65534);
      a.write(pcm(704, 310));
      await until(
        'new epoch packets',
        () => one.audioPackets >= 6 && two.audioPackets >= 5,
      );
      assertEquals(
        audio(one).slice(-2).map((p) =>
          new DataView(p.buffer, p.byteOffset).getUint16(2)
        ),
        [0, 1],
      );
      // Old cache requests must still fail after the replacement cache fills.
      first.requestRetransmit(one.id, 65534);
      first.requestRetransmit(one.id, 0);
      await until('new cache positive barrier', () => one.audioPackets >= 7);
      assertEquals([one.audioPackets, two.audioPackets], [7, 5]);
      const both = new Uint8Array(1408 * 4);
      both.set(pcm(704, 10));
      both.set(pcm(704, 310), 704 * 4);
      await Promise.all([
        rendered(first, both, deduplicated, 1),
        rendered(second, both, deduplicated, 1),
      ]);
      const oldService = one.endpoints!.senderControl!;
      const timing = one.endpoints!.senderTiming!;
      await a.close();
      await b.attach(third);
      const three = third.sessions[0];
      assert(three.endpoints!.senderControl!.port !== oldService.port);
      assertEquals(
        three.endpoints!.senderTiming,
        timing,
        'stateless timing stays shared',
      );
      b.write(pcm(704, 900));
      await until('B original packets', () => three.audioPackets >= 2);
      assertEquals(
        three.rtpSequences,
        [65534, 65535],
        'cross-stream sequence numbers intentionally overlap',
      );
      const bOriginal = audio(three)[0].slice();
      first.requestRetransmit(one.id, 65534, three.endpoints!.senderControl!);
      third.requestRetransmit(three.id, 65534);
      await until(
        'B valid endpoint behind old endpoint',
        () => three.audioPackets >= 3,
      );
      assertEquals(three.audioPackets, 3);
      retransmission(audio(three).at(-1), bOriginal);
      assertEquals([one.audioPackets, two.audioPackets], [7, 5]);
      await rendered(third, pcm(704, 900), deduplicated);
      await libraryProof();
    } finally {
      spoof.close();
      await a.close();
      await b.close();
      first.close();
      second.close();
      third.close();
    }
  },
});

Deno.test({
  name:
    'RAOP isolation: dormant metadata survives foreign replacement, purge and retirement through keepalive',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const a = nativeStream(), b = nativeStream();
    const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    try {
      assertEquals(await b.metadata('Dormant B', 'Artist B', 700, 3456), 0);
      assertEquals(await a.metadata('Active A', 'Artist A', 100, 1234), 0);
      await a.attach(ra);
      a.write(pcm(704, 1));
      await rendered(ra, pcm(704, 1));
      assertEquals(await a.metadata('Replacement A', 'New A', 300, 1234), 0);
      await until(
        'A replacement receiver metadata',
        () => titles(ra.sessions[0]).some((s) => s.includes('Replacement A')),
      );
      await a.close();
      await b.attach(rb);
      await until(
        'B retained startup text',
        () => titles(rb.sessions[0]).length > 0,
      );
      assert(
        titles(rb.sessions[0]).every((s) =>
          s.includes('Dormant B') && s.includes('Artist B') &&
          !s.includes('Active A') && !s.includes('Replacement A')
        ),
      );
      b.write(pcm(704, 900));
      await rendered(rb, pcm(704, 900));
      // Use the real 25-second scheduler, not an accelerated production knob.
      await until(
        'B 25-second keepalive',
        () =>
          progress(rb.sessions[0]).some((p) =>
            p.atMs - rb.sessions[0].requests[0].atMs >= 20000
          ),
        32000,
      );
      const last = progress(rb.sessions[0]).at(-1)!;
      assertEquals(
        (last.end - last.display) >>> 0,
        Math.floor(3456 * 44100 / 1000) + 30720,
      );
      assertEquals(rb.sessions[0].sdp.includes('a=rsaaeskey:'), false);
      await libraryProof();
    } finally {
      await a.close();
      await b.close();
      ra.close();
      rb.close();
    }
  },
});

Deno.test({
  name:
    'RAOP isolation: later metadata-capable peer receives stream content when first peer wants none',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const a = nativeStream();
    const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    try {
      assertEquals(await a.metadata('One stream', 'Both peers', 0, 1000), 0);
      await a.attach(ra, 0);
      await a.attach(rb, 5);
      await until(
        'late peer metadata',
        () => titles(rb.sessions[0]).length > 0,
      );
      assert(
        titles(rb.sessions[0]).every((s) =>
          s.includes('One stream') && s.includes('Both peers')
        ),
      );
      assertEquals(titles(ra.sessions[0]), []);
      a.write(pcm(704, 400));
      await Promise.all([
        rendered(ra, pcm(704, 400)),
        rendered(rb, pcm(704, 400)),
      ]);
      await libraryProof();
    } finally {
      await a.close();
      ra.close();
      rb.close();
    }
  },
});
