import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  createFfiSpawn,
  createFfiStream,
  raopFfiInternals,
} from '../src/boots/raop-ffi.ts';
import { profileFromService } from '../src/boots/airplay-profile.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';

const input = {
  volume: 50,
  positionMs: 0,
  lengthMs: 1000,
  title: '',
  artist: '',
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(what: string, predicate: () => boolean) {
  const deadline = performance.now() + 15000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${what}`);
    await pause();
  }
}
function pcm(frames: number) {
  const bytes = new Uint8Array(frames * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, -15000 + i * 17, true);
    view.setInt16(i * 4 + 2, 14000 - i * 19, true);
  }
  return bytes;
}
type Receiver = Awaited<ReturnType<typeof startFakeRaop>>;
function timestamps(fake: Receiver) {
  return fake.sessions[0].wire.flatMap((event) =>
    event.kind === 'audio'
      ? [
        new DataView(
          event.data.buffer,
          event.data.byteOffset,
          event.data.byteLength,
        ).getUint32(4),
      ]
      : []
  );
}
function profile(fake: Receiver) {
  return profileFromService({
    name: '001122334455@Stream._raop._tcp.local',
    host: 'fixture.local',
    address: '127.0.0.1',
    port: fake.port,
    ttlMs: 60000,
    txt: { tp: 'UDP', am: 'AppleTV2,1' },
  });
}
async function libraryProof() {
  const expected = await Deno.realPath(
    new URL('../helper/raop/libmelofon_raop.so', import.meta.url),
  );
  assertEquals(
    await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!),
    expected,
  );
  assert(
    (await Deno.readTextFile('/proc/self/maps')).split('\n').some((line) =>
      line.endsWith(` ${expected}`)
    ),
  );
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(expected)),
  );
  console.log(
    `stream native library: ${expected} sha256=${
      Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
async function rendered(fake: Receiver, expected: Uint8Array) {
  const session = fake.sessions[0];
  await until(
    'audio and independent timing mapping',
    () =>
      session.audioPackets >= expected.length / (352 * 4) &&
      session.wire.some((event) => event.kind === 'timing-reply'),
  );
  assertEquals(
    decodeReceiverAudio(session.sdp, session.audioPayloads),
    expected,
  );
  const pending = renderScheduledAudio(session, fake.nowMs());
  assertEquals(pending.issues, []);
  assert(pending.lastPresentationAtMs !== null);
  assert(pending.clockUncertaintyMs !== null);
  await until(
    'scheduled real-frame boundary',
    () =>
      fake.nowMs() >
        pending.lastPresentationAtMs! + pending.clockUncertaintyMs!,
  );
  const result = renderScheduledAudio(session, fake.nowMs());
  assertEquals(result.issues, []);
  assertEquals(result.pcm, expected);
  assertEquals(result.pendingFrames, 0);
  assertEquals(result.discarded, []);
  assertEquals(session.flushes, 0);
  assertEquals(session.teardowns, 0);
  assertEquals(fake.sessions.length, 1);
}

Deno.test({
  name: 'RAOP stream: one input fans exact scheduled PCM to two attachments',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    const a = await startFakeRaop({ captureAudio: true, captureWire: true });
    const b = await startFakeRaop({ captureAudio: true, captureWire: true });
    let connected = 0;
    const event = (kind: string, value?: string) => {
      if (kind === 'state' && value === 'connected') connected++;
    };
    const first = stream.attach(event), second = stream.attach(event);
    try {
      assertEquals(typeof stream.id, 'bigint');
      assert(stream.id > 1n);
      assert(first.id !== second.id && first.id > 0n);
      assertEquals(first.streamId, stream.id);
      assertEquals(second.streamId, stream.id);
      await Promise.all([
        first.start(profile(a), input),
        second.start(profile(b), input),
      ]);
      await until('two ready attachments', () => connected === 2);
      await assertRejects(
        () => first.transport.pcm(pcm(352)),
        Error,
        'belongs to the RAOP stream',
      );
      await stream.pcm(pcm(704));
      await Promise.all([rendered(a, pcm(704)), rendered(b, pcm(704))]);
      assertEquals(timestamps(a), timestamps(b));
      await libraryProof();
    } finally {
      await stream.close();
      a.close();
      b.close();
    }
  },
});

for (const removed of [0, 1]) {
  Deno.test({
    name: `RAOP stream: detach attachment ${
      removed + 1
    } preserves shared partial PCM and PTS`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const stream = createFfiStream();
      const receivers = await Promise.all(
        [0, 1].map(() =>
          startFakeRaop({ captureAudio: true, captureWire: true })
        ),
      );
      let connected = 0;
      const attachments = receivers.map(() =>
        stream.attach((kind, value) => {
          if (kind === 'state' && value === 'connected') connected++;
        })
      );
      try {
        await Promise.all(
          attachments.map((attachment, i) =>
            attachment.start(profile(receivers[i]), input)
          ),
        );
        await until('two ready attachments', () => connected === 2);
        const expected = pcm(704);
        // Exactly one native 441-frame tick: one 352-frame ALAC packet plus an
        // 89-frame partial block. Detach must never discard that shared tail.
        await stream.pcm(expected.subarray(0, 441 * 4));
        await until(
          'both receivers got the first packet',
          () => receivers.every((r) => r.sessions[0]?.audioPackets === 1),
        );
        const survivor = receivers[1 - removed];
        const originalTimestamp = timestamps(survivor)[0];
        await attachments[removed].transport.close();
        await until(
          'removed attachment locally closed',
          () => receivers[removed].sessions[0].closedAtMs !== null,
        );
        await stream.pcm(expected.subarray(441 * 4));
        await rendered(survivor, expected);
        assertEquals(timestamps(survivor)[1], (originalTimestamp + 352) >>> 0);
        assertEquals(receivers[removed].sessions[0].audioPackets, 1);
        await libraryProof();
      } finally {
        await stream.close();
        for (const receiver of receivers) receiver.close();
      }
    },
  });
}

Deno.test({
  name:
    'RAOP stream: dormant and compatibility contexts cannot cross-feed the active owner',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const a = createFfiStream(), b = createFfiStream();
    const first = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const refused = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    let ready = false;
    const owner = a.attach((kind, value) => {
      if (kind === 'state' && value === 'connected') ready = true;
    });
    const dormant = b.attach(() => {});
    const legacy = createFfiSpawn()(() => {});
    try {
      assert(b.id > a.id);
      await owner.start(profile(first), input);
      await until('active owner ready', () => ready);
      await assertRejects(
        () => dormant.start(profile(refused), input),
        Error,
        'active stream busy',
      );
      await assertRejects(
        () => legacy.start(profile(refused), input),
        Error,
        'active stream busy',
      );
      await assertRejects(() => b.pcm(pcm(352)), Error, 'active stream busy');
      await a.pcm(pcm(704));
      await rendered(first, pcm(704));
      assertEquals(
        refused.sessions.length,
        0,
        'refusal precedes RTSP allocation',
      );
      await owner.transport.close();
      await assertRejects(
        () => dormant.start(profile(refused), input),
        Error,
        'active stream busy',
      );
      await a.close();
      ready = false;
      const replacement = b.attach((kind, value) => {
        if (kind === 'state' && value === 'connected') ready = true;
      });
      await replacement.start(profile(refused), input);
      await until(
        'dormant context activated after proven release',
        () => ready,
      );
      await b.pcm(pcm(704));
      await rendered(refused, pcm(704));
      await libraryProof();
    } finally {
      await Promise.all([a.close(), b.close(), legacy.transport.close()]);
      first.close();
      refused.close();
    }
  },
});

Deno.test({
  name:
    'RAOP stream: compatibility ownership also refuses explicit activation and PCM',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const refused = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    let ready = false;
    const legacy = createFfiSpawn()((kind, value) => {
      if (kind === 'state' && value === 'connected') ready = true;
    });
    const attachment = stream.attach(() => {});
    try {
      await legacy.start(profile(receiver), input);
      await until('compatibility owner ready', () => ready);
      await assertRejects(
        () => attachment.start(profile(refused), input),
        Error,
        'active stream busy',
      );
      await assertRejects(
        () => stream.pcm(pcm(352)),
        Error,
        'active stream busy',
      );
      await legacy.transport.pcm(pcm(704));
      await rendered(receiver, pcm(704));
      assertEquals(refused.sessions.length, 0);
      await libraryProof();
    } finally {
      await stream.close();
      await legacy.transport.close();
      receiver.close();
      refused.close();
    }
  },
});

Deno.test({
  name:
    'RAOP stream: retained attachments prevent native free and dormant streams retain runtime',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const lib = raopFfiInternals.loadLibrary();
    const raw = lib.symbols.raop_stream_new();
    assert(raw);
    const id = lib.symbols.raop_stream_id(raw);
    const attachment = lib.symbols.raop_stream_attach(raw);
    assert(attachment);
    assertEquals(await lib.symbols.raop_stream_free(raw), -2);
    assertEquals(lib.symbols.raop_stream_id(raw), id);
    assertEquals(await lib.symbols.raop_free(attachment), 0);
    // The last device is gone, but its stream still owns the event loop/player.
    assertEquals(lib.symbols.raop_stream_write(raw, pcm(1), 4n), 4);
    assertEquals(lib.symbols.raop_stream_write(raw, pcm(1), 3n), -1);
    await libraryProof();
    assertEquals(await lib.symbols.raop_stream_free(raw), 0);
  },
});

Deno.test({
  name:
    'RAOP stream: close cancels and joins a backpressured producer before freeing',
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const stream = createFfiStream();
    await assertRejects(
      () => stream.pcm(new Uint8Array(3)),
      Error,
      'whole stereo frames',
    );
    const pending = stream.pcm(new Uint8Array((2 * 44100 + 1) * 4));
    const rejected = assertRejects(() => pending, Error, 'producer canceled');
    await libraryProof();
    const closing = stream.close();
    assertEquals(stream.close(), closing);
    await rejected;
    await closing;
    assertThrows(() => stream.attach(() => {}), Error, 'closed');
    await assertRejects(() => stream.pcm(pcm(1)), Error, 'closed');
  },
});
