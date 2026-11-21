import { assert, assertEquals, assertRejects } from '@std/assert';
import { createSocket } from 'node:dgram';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import {
  createFfiStream,
  raopFfiInternals,
  shutdownNativeLogging,
} from '../src/boots/raop-ffi.ts';
import { profileFromService } from '../src/boots/airplay-profile.ts';
import type { FakeRaopSession } from './helpers/fake-raop.ts';
import {
  faultChild,
  libraryProof,
  nativeStream,
  pcm,
  progress,
  progressChild,
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
async function timelineRendered(
  receiver: Awaited<ReturnType<typeof startFakeRaop>>,
  expected: Uint8Array,
) {
  const session = receiver.sessions[0];
  await until(
    'independent real source presentation',
    () =>
      session.wire.some((e) => e.kind === 'timing-reply') &&
      renderScheduledAudio(session, receiver.nowMs()).pcm.length >=
        expected.length,
  );
  const result = renderScheduledAudio(session, receiver.nowMs());
  assertEquals(result.issues, []);
  assertEquals(result.discarded, []);
  assertEquals(result.pcm.subarray(0, expected.length), expected);
  assert(
    result.pcm.subarray(expected.length).every((v) => v === 0),
    'all scheduled transport silence is zero',
  );
  const bytes = decodeReceiverAudio(session.sdp, session.audioPayloads);
  assertEquals(bytes.subarray(0, expected.length), expected);
  assert(
    bytes.subarray(expected.length).every((v) => v === 0),
    'all packet padding/drain silence is zero',
  );
  assertEquals([session.flushes, session.teardowns, receiver.sessions.length], [
    0,
    0,
    1,
  ]);
}

for (
  const [mode, error] of [
    ['encoder', 2n],
    ['cipher', 3n],
    ['send', 4n],
    ['sync', 5n],
    ['timer', 7n],
    ['allocation', 1n],
  ] as const
) {
  const name =
    `RAOP isolation acceptance: ${mode} failure in A cannot fail or truncate B`;
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      if (await progressChild(name, mode)) return;
      // The timer observer selects the most recently constructed player, A.
      const b = nativeStream(), a = nativeStream();
      const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
      const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
      const faults = Deno.dlopen(Deno.env.get('RAOP_ISOLATION_PROGRESS_LIB')!, {
        raop_fi_target_stream: { parameters: ['u64'], result: 'void' },
      });
      try {
        await b.attach(rb);
        await a.attach(ra, 0, mode === 'cipher');
        faults.symbols.raop_fi_target_stream(a.id);
        const expected = pcm(44100 + 137, 180);
        b.source(1n, expected);
        b.seal(1n, BigInt(expected.length / 4));
        b.end(BigInt(expected.length / 4));
        await until(
          'B active before A fault',
          () => rb.sessions[0].audioPackets >= 2,
        );
        // Output faults require real A input, but the timer can fail while A
        // is idle. Admit and seal A before arming that independent fault.
        if (mode !== 'timer') {
          await Deno.writeTextFile(Deno.env.get('RAOP_PROGRESS_ARM')!, 'arm');
        }
        a.source(1n, pcm(704, 800));
        a.seal(1n, 704n);
        a.end(704n);
        if (mode === 'timer') {
          await Deno.writeTextFile(Deno.env.get('RAOP_PROGRESS_ARM')!, 'arm');
        }
        await until(
          'A explicit terminal failure',
          async () => (await a.completion(1n))[6] !== 0n,
        );
        const failed = await a.completion(1n);
        assertEquals([failed[6], failed[7]], [3n, error]);
        await a.close();
        await until(
          'B independent successful completion',
          async () => (await b.completion(1n))[6] !== 0n,
        );
        const completed = await b.completion(1n);
        assertEquals(
          [completed[3], completed[6], completed[7], completed[11]],
          [BigInt(expected.length / 4), 1n, 0n, 1n],
        );
        const snapshot = await b.snapshot(1n);
        assertEquals([snapshot[5], snapshot[14]], [
          0n,
          BigInt(expected.length / 4),
        ]);
        await timelineRendered(rb, expected);
        assertEquals(rb.sessions[0].closedAtMs, null);
        await libraryProof();
      } finally {
        await a.close();
        await b.close();
        ra.close();
        rb.close();
        faults.close();
      }
    },
  });
}

const wrapName =
  'RAOP isolation acceptance: long wrapping timelines retain every receipt through state-ring overflow';
Deno.test({
  name: wrapName,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (await progressChild(wrapName, 'none')) return;
    const a = nativeStream(), b = nativeStream();
    const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    const lib = raopFfiInternals.loadLibrary().symbols;
    try {
      const handle = await a.attach(ra);
      await b.attach(rb);
      const expectedA = new Uint8Array(24 * 352 * 4);
      for (let i = 0; i < 24; i++) {
        const bytes = pcm(352, i * 197);
        expectedA.set(bytes, i * 352 * 4);
        a.source(BigInt(i + 1), bytes);
        a.seal(BigInt(i + 1), 352n);
      }
      a.end(BigInt(expectedA.length / 4));
      const expectedB = pcm(79300, 501);
      b.source(1n, expectedB);
      b.seal(1n, 79300n);
      b.end(79300n);
      await until(
        'both wrapped clocks emitted',
        () =>
          ra.sessions[0].audioPackets >= 3 && rb.sessions[0].audioPackets >= 3,
      );
      for (const receiver of [ra, rb]) {
        const packets = audio(receiver.sessions[0]);
        assertEquals(receiver.sessions[0].rtpSequences.slice(0, 3), [
          65534,
          65535,
          0,
        ]);
        const timestamp = (p: Uint8Array) =>
          new DataView(p.buffer, p.byteOffset).getUint32(4);
        assert(
          timestamp(packets[2]) < timestamp(packets[0]),
          'RTP timestamp wrapped too',
        );
      }
      for (let i = 0; i < 40; i++) {
        assertEquals(lib.raop_volume(handle, i + 10), 0);
      }
      await until(
        'all protocol state updates acknowledged by receiver',
        () => ra.sessions[0].volumeParams.length === 41,
      );
      await until(
        'last A source completed',
        async () => (await a.completion(24n))[6] === 1n,
      );
      const events = new Uint8Array(4096);
      let retainedEvents = 0;
      while (lib.raop_poll(handle, events, BigInt(events.length)) > 0) {
        retainedEvents++;
      }
      assert(
        retainedEvents > 0 && retainedEvents < 40,
        'lossy state ring overflowed',
      );
      // Completion storage is independent: do not poll/ack any source until now.
      for (let i = 1n; i <= 24n; i++) {
        const r = await a.completion(i);
        assertEquals([r[0], r[2], r[3], r[6], r[7]], [a.id, i, 352n, 1n, 0n]);
        assertEquals(
          lib.raop_stream_completion_ack(a.pointer, 1n, i, 352n, 1n),
          0,
        );
      }
      await timelineRendered(ra, expectedA);
      await a.close();
      await until(
        'B long timeline complete',
        async () => (await b.completion(1n))[6] === 1n,
      );
      const snapshot = await b.snapshot(1n);
      assert(snapshot[8] >= 79300n && snapshot[9] >= 79300n);
      assertEquals(snapshot[14], 79300n);
      await timelineRendered(rb, expectedB);
      await libraryProof();
    } finally {
      await a.close();
      await b.close();
      ra.close();
      rb.close();
    }
  },
});

const slowName =
  'RAOP isolation acceptance: slow A terminal write and stream recreation do not block B timeline';
Deno.test({
  name: slowName,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (await faultChild(slowName)) return;
    const a = nativeStream(), b = nativeStream();
    const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    const observer = Deno.dlopen(Deno.env.get('RAOP_ISOLATION_FAULT_LIB')!, {
      raop_fi_write_blocking: { parameters: [], result: 'i32' },
    });
    let replacement: ReturnType<typeof nativeStream> | undefined;
    try {
      await a.attach(ra);
      await b.attach(rb);
      const expected = pcm(79300, 620);
      b.source(1n, expected);
      b.seal(1n, 79300n);
      b.end(79300n);
      a.write(pcm(352, 3));
      await until(
        'both active before slow release',
        () =>
          ra.sessions[0].audioPackets === 1 && rb.sessions[0].audioPackets >= 1,
      );
      await Deno.writeTextFile(
        Deno.env.get('RAOP_FI_WRITE_BLOCK_ARM_FILE')!,
        'arm',
      );
      let closed = false;
      const closing = a.close().then(() => closed = true);
      await until(
        'A terminal write held by real dependency',
        () => observer.symbols.raop_fi_write_blocking() === 1,
      );
      const packets = rb.sessions[0].audioPackets;
      await until(
        'B emits while A close is pending',
        () => rb.sessions[0].audioPackets > packets + 3,
      );
      assertEquals(closed, false);
      await closing;
      replacement = nativeStream();
      assert(
        replacement.id > a.id,
        'destroy/recreate never reuses stream identity',
      );
      await replacement.metadata('Fresh A', 'New incarnation', 0, 1000);
      await replacement.attach(ra);
      replacement.write(pcm(704, 1011));
      await rendered({ ...ra, sessions: [ra.sessions[1]] }, pcm(704, 1011));
      await until(
        'recreated A metadata',
        () => titles(ra.sessions[1]).length > 0,
      );
      assert(
        titles(ra.sessions[1]).every((s) =>
          s.includes('Fresh A') && s.includes('New incarnation')
        ),
      );
      assertEquals(ra.sessions[0].teardowns, 1);
      await until(
        'B completed despite slow A release',
        async () => (await b.completion(1n))[6] === 1n,
      );
      await timelineRendered(rb, expected);
      assertEquals(rb.sessions[0].closedAtMs, null);
      await libraryProof();
    } finally {
      await replacement?.close();
      await a.close();
      await b.close();
      ra.close();
      rb.close();
      observer.close();
    }
  },
});

const closeName =
  'RAOP isolation acceptance: close joins retained polls and backpressure without unloading B';
Deno.test({
  name: closeName,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (await faultChild(closeName)) return;
    const a = createFfiStream(),
      blocked = createFfiStream(),
      b = createFfiStream();
    const observer = Deno.dlopen(Deno.env.get('RAOP_ISOLATION_FAULT_LIB')!, {
      raop_fi_poll_blocking: { parameters: [], result: 'i32' },
    });
    const hold = Deno.env.get('RAOP_FI_POLL_ARM_FILE')!;
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    let connected = false;
    const peer = b.attach((kind, value) => {
      if (kind === 'state' && value === 'connected') connected = true;
    });
    a.attach(() => {}); // A retained source has a participant, not vacuous success.
    try {
      await peer.start(
        profileFromService({
          name: '001122334455@B._raop._tcp.local',
          host: 'fixture.local',
          address: '127.0.0.1',
          port: rb.port,
          ttlMs: 60000,
          txt: { tp: 'UDP', am: 'AppleTV2,1' },
        }),
        { volume: 50, positionMs: 0, lengthMs: 1000, title: 'B', artist: 'B' },
      );
      await until('B typed stream ready', () => connected);
      const expected = pcm(704, 130);
      await b.pcm(expected.subarray(0, 441 * 4));
      await until(
        'B typed partial packet',
        () => rb.sessions[0].audioPackets === 1,
      );
      assertEquals(
        (await a.appendSource({
          epoch: a.epoch,
          source: 1n,
          segment: 1n,
          pcm: pcm(353),
        })).status,
        'accepted',
      );
      await a.seal(a.epoch, 1n, 353n);
      const key = { epoch: a.epoch, source: 1n, target: 353n, revision: 1n };
      await Deno.writeTextFile(hold, 'hold');
      const waiting = a.waitCompletion(key), reading = a.pollCompletion(key);
      await until(
        'native completion reads held after reservation',
        () => observer.symbols.raop_fi_poll_blocking() === 1,
      );
      const writer = blocked.pcm(new Uint8Array((2 * 44100 + 1) * 4));
      const rejected = assertRejects(() => writer, Error, 'producer canceled');
      let closedA = false;
      const closingA = a.close().then(() => closedA = true),
        closingWriter = blocked.close();
      await b.pcm(expected.subarray(441 * 4));
      await until(
        'B continues while A polls block its close',
        () => rb.sessions[0].audioPackets === 2,
      );
      assertEquals(
        closedA,
        false,
        'stream free must join the reserved native readers',
      );
      await Deno.remove(hold);
      const canceled = await waiting;
      assertEquals(canceled.status, 'canceled');
      assertEquals(canceled.attachments[0].outcome, 'canceled');
      assertEquals((await reading)!.status, 'canceled');
      await Promise.all([closingA, closingWriter, rejected]);
      shutdownNativeLogging(); // B's typed stream and handle retain the library/log owner.
      await rendered(rb, expected);
      assertEquals(rb.sessions[0].closedAtMs, null);
      await assertRejects(() => a.pollCompletion(key), Error, 'closed');
      await libraryProof();
    } finally {
      await Deno.remove(hold).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
      await a.close();
      await blocked.close();
      await b.close();
      rb.close();
      observer.close();
    }
  },
});
for (const concurrent of [false, true]) {
  const routingName = `RAOP isolation: ${
    concurrent ? 'concurrent' : 'sequential'
  } same-IP endpoints, overlapping sequences and canceled caches route only to their owner`;
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
            RAOP_ROUTING_LIB: interposer,
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
        if (concurrent) {
          await b.attach(third);
          b.write(pcm(704, 900));
          await until(
            'concurrent B original packets',
            () => third.sessions[0].audioPackets === 2,
          );
          const three = third.sessions[0];
          assert(
            three.endpoints!.senderControl!.port !==
              first.sessions[0].endpoints!.senderControl!.port,
          );
          first.requestRetransmit(
            first.sessions[0].id,
            65534,
            three.endpoints!.senderControl!,
          );
          third.requestRetransmit(three.id, 65534);
          await until(
            'concurrent B endpoint routing',
            () => three.audioPackets === 3,
          );
          retransmission(audio(three).at(-1), audio(three)[0]);
        }
        a.write(pcm(704, 10));
        await Promise.all([
          rendered(first, pcm(704, 10)),
          rendered(second, pcm(704, 10)),
        ]);
        if (concurrent) {
          const observer = Deno.dlopen(Deno.env.get('RAOP_ROUTING_LIB')!, {
            raop_fi_encoder_count: { parameters: [], result: 'u32' },
          });
          assertEquals(
            observer.symbols.raop_fi_encoder_count(),
            2,
            'A peers share one encoder/master; B of the same format has its own',
          );
          observer.close();
        }
        const one = first.sessions[0], two = second.sessions[0];
        assertEquals(one.rtpSequences, [65534, 65535]);
        assertEquals(two.rtpSequences, one.rtpSequences);
        assertEquals(
          one.endpoints!.senderControl,
          two.endpoints!.senderControl,
        );
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
        if (!concurrent) await b.attach(third);
        const three = third.sessions[0];
        assert(three.endpoints!.senderControl!.port !== oldService.port);
        assertEquals(
          three.endpoints!.senderTiming,
          timing,
          'stateless timing stays shared',
        );
        if (!concurrent) b.write(pcm(704, 900));
        await until('B original packets', () => three.audioPackets >= 2);
        assertEquals(
          three.rtpSequences.slice(0, 2),
          [65534, 65535],
          'cross-stream sequence numbers intentionally overlap',
        );
        const bOriginal = audio(three)[0].slice();
        const before = three.audioPackets;
        first.requestRetransmit(one.id, 65534, three.endpoints!.senderControl!);
        third.requestRetransmit(three.id, 65534);
        await until(
          'B valid endpoint behind old endpoint',
          () => three.audioPackets >= before + 1,
        );
        assertEquals(three.audioPackets, before + 1);
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
}

for (const operation of ['cancel', 'drain', 'free']) {
  Deno.test({
    name:
      `RAOP isolation: A ${operation}/free preserves B partial block, schedule and sockets`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const a = nativeStream(), b = nativeStream();
      const receivers = await Promise.all(
        [0, 1, 2].map(() =>
          startFakeRaop({ captureAudio: true, captureWire: true })
        ),
      );
      const [first, second, third] = receivers;
      try {
        await a.metadata('A', 'A artist', 0, 1000);
        await b.metadata('B', 'B artist', 0, 2000);
        await a.attach(first);
        await a.attach(second);
        if (operation === 'drain') {
          a.source(1n, pcm(704, 5));
          a.seal(1n, 704n);
          a.end(704n);
        } else a.write(pcm(704, 5));
        await until(
          'A packets submitted',
          () => first.sessions[0].audioPackets >= 2,
        );
        await b.attach(third);
        const expected = pcm(704, 711);
        b.write(expected.subarray(0, 441 * 4));
        await until(
          'B first block, with 89 frames retained',
          () => third.sessions[0].audioPackets === 1,
        );
        const before = await b.snapshot();
        assertEquals([before[4], before[5], before[6], before[8]], [
          1n,
          0n,
          1n,
          352n,
        ]);
        const packet = audio(third.sessions[0])[0];
        const timestamp = new DataView(packet.buffer, packet.byteOffset)
          .getUint32(4);
        if (operation === 'cancel') await a.cancel();
        if (operation === 'drain') {
          await until(
            'A retained scheduled completion',
            async () => (await a.completion(1n))[6] === 1n,
          );
          // The byte-only port does not pace starvation silence. Supply its
          // continuation before doing independent decoder work on A.
          b.write(expected.subarray(441 * 4));
          await until(
            'B continuation captured before synchronous A decode',
            () => third.sessions[0].audioPackets === 2,
          );
          for (const receiver of [first, second]) {
            const session = receiver.sessions[0];
            const bytes = decodeReceiverAudio(
              session.sdp,
              session.audioPayloads,
            );
            assertEquals(bytes.subarray(0, 704 * 4), pcm(704, 5));
            assert(bytes.subarray(704 * 4).every((v) => v === 0));
            const scheduled = renderScheduledAudio(session, receiver.nowMs());
            assertEquals(scheduled.issues, []);
            assertEquals(scheduled.pcm.subarray(0, 704 * 4), pcm(704, 5));
          }
        }
        await a.close();
        if (operation !== 'drain') b.write(expected.subarray(441 * 4));
        await rendered(third, expected);
        const after = await b.snapshot();
        assertEquals([after[4], after[5], after[6], after[8], after[10]], [
          1n,
          0n,
          1n,
          704n,
          before[10],
        ]);
        assert(after[9] >= before[9]);
        const last = audio(third.sessions[0])[1];
        assertEquals(
          new DataView(last.buffer, last.byteOffset).getUint32(4),
          (timestamp + 352) >>> 0,
        );
        assert(
          titles(third.sessions[0]).every((s) =>
            s.includes('B artist') && !s.includes('A artist')
          ),
        );
        assertEquals(third.sessions[0].closedAtMs, null);
        await libraryProof();
      } finally {
        await a.close();
        await b.close();
        receivers.forEach((r) => r.close());
      }
    },
  });
}

Deno.test({
  name:
    'RAOP isolation: concurrent metadata and real keepalive select each live context',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const a = nativeStream(), b = nativeStream();
    const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    try {
      await a.metadata('Concurrent A', 'Artist A', 100, 1234);
      await b.metadata('Concurrent B', 'Artist B', 700, 3456);
      await a.attach(ra);
      await b.attach(rb);
      a.write(pcm(704, 1));
      b.write(pcm(704, 900));
      await Promise.all([
        rendered(ra, pcm(704, 1)),
        rendered(rb, pcm(704, 900)),
      ]);
      await a.metadata('Updated A', 'New A', 300, 1234);
      await until(
        'A metadata update',
        () => titles(ra.sessions[0]).some((s) => s.includes('Updated A')),
      );
      await until(
        'both real keepalives',
        () =>
          [ra, rb].every((r) =>
            progress(r.sessions[0]).some(
              (p) => p.atMs - r.sessions[0].requests[0].atMs >= 20000,
            )
          ),
        32000,
      );
      await until(
        'B text metadata independently of keepalive',
        () => titles(rb.sessions[0]).length > 0,
      );
      assert(
        titles(rb.sessions[0]).every((s) =>
          s.includes('Concurrent B') && s.includes('Artist B') &&
          !s.includes('Updated A')
        ),
      );
      for (const [receiver, length] of [[ra, 1234], [rb, 3456]] as const) {
        const p = progress(receiver.sessions[0]).at(-1)!;
        assertEquals(
          (p.end - p.display) >>> 0,
          Math.floor(length * 44100 / 1000) + 30720,
        );
      }
      await libraryProof();
    } finally {
      await a.close();
      await b.close();
      ra.close();
      rb.close();
    }
  },
});

const lifetimeName =
  'RAOP isolation: allocation rollback and failed free retain only their own runtime resources';
Deno.test({
  name: lifetimeName,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (await faultChild(lifetimeName)) return;
    const faults = Deno.dlopen(Deno.env.get('RAOP_ISOLATION_FAULT_LIB')!, {
      raop_fi_allocation_stage: { parameters: ['i32'], result: 'void' },
    });
    const lib = raopFfiInternals.loadLibrary().symbols;
    const a = nativeStream(), b = nativeStream();
    const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    try {
      await b.attach(rb);
      const expected = pcm(704, 200);
      b.write(expected.subarray(0, 441 * 4));
      await until(
        'B retained partial input',
        () => rb.sessions[0].audioPackets === 1,
      );
      for (const stage of [1, 2]) {
        faults.symbols.raop_fi_allocation_stage(stage);
        assertEquals(
          lib.raop_stream_new(),
          null,
          'failed player construction rolls back runtime acquire',
        );
      }
      faults.symbols.raop_fi_allocation_stage(2);
      assertEquals(
        lib.raop_stream_attach(a.pointer),
        null,
        'failed attachment event rolls back runtime and membership',
      );
      const handle = await a.attach(ra);
      a.write(pcm(352, 7));
      await until(
        'A packet before failed release',
        () => ra.sessions[0].audioPackets === 1,
      );
      await Deno.writeTextFile(
        Deno.env.get('RAOP_FI_RELEASE_ALLOC_ARM_FILE')!,
        'arm',
      );
      assertEquals(await lib.raop_free(handle), -1);
      assertEquals(
        await lib.raop_stream_free(a.pointer),
        -2,
        'failed native free retains attachment storage',
      );
      b.write(expected.subarray(441 * 4));
      await rendered(rb, expected);
      await a.close(); // Test-owned retained raw handle, not a public quarantine reset.
      const dormant = nativeStream();
      await b.close();
      // Last device is gone; dormant stream still owns a working runtime.
      assertEquals(
        await dormant.metadata('Retained runtime', 'No devices', 0, 1000),
        0,
      );
      await dormant.close();
      const restarted = nativeStream();
      assertEquals(
        await restarted.metadata('Fresh runtime', 'Restart', 0, 1000),
        0,
      );
      await restarted.close();
      await libraryProof();
    } finally {
      await a.close();
      await b.close();
      ra.close();
      rb.close();
      faults.close();
    }
  },
});

Deno.test({
  name:
    'RAOP isolation: probe-only attachment and last-device release leave B input untouched',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const a = nativeStream(), b = nativeStream();
    const ra = await startFakeRaop({ captureAudio: true, captureWire: true });
    const rb = await startFakeRaop({ captureAudio: true, captureWire: true });
    try {
      await b.attach(rb);
      const expected = pcm(704, 819);
      b.write(expected.subarray(0, 441 * 4));
      await until(
        'B partial block before probe',
        () => rb.sessions[0].audioPackets === 1,
      );
      await a.attach(ra, 0, false, true);
      assertEquals(ra.sessions[0].audioPackets, 0);
      await a.close();
      b.write(expected.subarray(441 * 4));
      await rendered(rb, expected);
      assertEquals(rb.sessions[0].closedAtMs, null);
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
      assert(
        ((last.pos - last.display) >>> 0) <= ((last.end - last.display) >>> 0),
        'short pre-anchor input never turns host uptime into track progress',
      );
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
