// Ordered timeline ingress -> shipping native library -> independently scheduled
// UDP/ALAC consumer. Pacer ranges are not scheduled completion receipts.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { createFfiStream, raopFfiInternals } from '../src/boots/raop-ffi.ts';
import {
  type AirplayRangeSnapshot,
  profileFromService,
} from '../src/boots/airplay-profile.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';

type Stream = ReturnType<typeof createFfiStream>;
type Receiver = Awaited<ReturnType<typeof startFakeRaop>>;
const highSource = 0xfedcba9876543210n;
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(
  what: string,
  predicate: () => boolean | Promise<boolean>,
) {
  const deadline = performance.now() + 15000;
  while (!await predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep();
  }
}
function pcm(frames: number, seed = 0) {
  const bytes = new Uint8Array(frames * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, (i * 17 + seed) % 30001 - 15000, true);
    view.setInt16(i * 4 + 2, 14000 - (i * 19 + seed) % 28001, true);
  }
  return bytes;
}
function profile(receiver: Receiver) {
  return profileFromService({
    name: '001122334455@Timeline._raop._tcp.local',
    host: 'fixture.local',
    address: '127.0.0.1',
    port: receiver.port,
    ttlMs: 60000,
    txt: { tp: 'UDP', am: 'AppleTV2,1' },
  });
}
const item = {
  volume: 50,
  positionMs: 0,
  lengthMs: 10000,
  title: '',
  artist: '',
};
async function libraryProof() {
  const path = await Deno.realPath(
    new URL('../helper/raop/libmelofon_raop.so', import.meta.url),
  );
  assertEquals(await Deno.realPath(Deno.env.get('MELOFON_RAOP_LIB')!), path);
  assert(
    (await Deno.readTextFile('/proc/self/maps')).split('\n').some((line) =>
      line.endsWith(` ${path}`)
    ),
  );
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(path)),
  );
  console.log(
    `playout native library: ${path} sha256=${
      Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `RAOP timeline: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
async function append(
  stream: Stream,
  source: bigint,
  bytes: Uint8Array,
  segment = source,
) {
  let offset = 0;
  do {
    const r = await stream.appendSource({
      epoch: stream.epoch,
      source,
      segment,
      pcm: bytes.subarray(offset),
    });
    assert(
      ['accepted', 'backpressure'].includes(r.status),
      JSON.stringify(r, (_, v) => typeof v === 'bigint' ? String(v) : v),
    );
    offset += Number(r.acceptedFrames) * 4;
    if (r.status === 'backpressure') await sleep();
  } while (offset < bytes.length);
}
async function ranges(stream: Stream) {
  const all: AirplayRangeSnapshot[] = [];
  for (let i = 0n;; i++) {
    const r = await stream.range(stream.epoch, i);
    if (!r) break;
    assertEquals(r.transportStart, all.reduce((n, r) => n + r.frames, 0n));
    all.push(r);
  }
  return all;
}
function accounted(
  bytes: Uint8Array,
  all: AirplayRangeSnapshot[],
  sources: Map<bigint, Uint8Array>,
) {
  const expected = new Uint8Array(bytes.length);
  let covered = 0;
  for (const r of all) {
    const start = Number(r.transportStart) * 4;
    const length = Math.min(Number(r.frames) * 4, bytes.length - start);
    if (length <= 0) break;
    if (r.kind === 'real') {
      const source = sources.get(r.source);
      assert(source);
      const offset = Number(r.sourceOffset) * 4;
      assert(offset + length <= source.length);
      expected.set(source.subarray(offset, offset + length), start);
    } else {
      assertEquals([r.source, r.segment, r.sourceOffset], [0n, 0n, 0n]);
    }
    covered += length;
  }
  assertEquals(
    covered,
    bytes.length,
    'every transport byte is range-accounted',
  );
  assertEquals(
    bytes,
    expected,
    'all real bytes exact once, all labeled silence zero',
  );
}
async function rendered(
  stream: Stream,
  receiver: Receiver,
  realEnd: number,
  sources: Map<bigint, Uint8Array>,
) {
  const packetEnd = Math.ceil(realEnd / 352) * 352;
  await until('independently scheduled final packet', () => {
    const session = receiver.sessions[0];
    return !!session?.wire.some((e) => e.kind === 'timing-reply') &&
      renderScheduledAudio(session, receiver.nowMs()).pcm.length >=
        packetEnd * 4;
  });
  const session = receiver.sessions[0];
  const result = renderScheduledAudio(session, receiver.nowMs());
  assertEquals(result.issues, []);
  assertEquals(result.discarded, []);
  assert(result.ranges.length > 0 && result.clockUncertaintyMs !== null);
  for (let i = 1; i < result.ranges.length; i++) {
    assertEquals(
      result.ranges[i].timestamp,
      result.ranges[i - 1].timestamp + result.ranges[i - 1].frames,
    );
  }
  const all = await ranges(stream);
  accounted(result.pcm, all, sources);
  accounted(
    decodeReceiverAudio(session.sdp, session.audioPayloads),
    all,
    sources,
  );
  assertEquals([session.flushes, session.teardowns, receiver.sessions.length], [
    0,
    0,
    1,
  ]);
  return { all, result };
}

for (const frames of [1, 351, 352, 353, 441, 44100 + 137]) {
  test(`seal/end renders ${frames} real frames and exact zero transport padding`, async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const source = pcm(frames);
    const attachment = stream.attach(() => {});
    try {
      await append(stream, highSource, source);
      const marker = await stream.seal(
        stream.epoch,
        highSource,
        BigInt(frames),
      );
      assertEquals(marker, {
        streamId: stream.id,
        epoch: stream.epoch,
        source: highSource,
        target: BigInt(frames),
        inputEnd: BigInt(frames),
        status: 'accepted',
      });
      assertEquals(
        await stream.seal(stream.epoch, highSource, BigInt(frames)),
        marker,
      );
      assertEquals(
        (await stream.endStream(stream.epoch, BigInt(frames))).status,
        'accepted',
      );
      assertEquals(await stream.source(stream.epoch, highSource), {
        streamId: stream.id,
        epoch: stream.epoch,
        source: highSource,
        acceptedFrames: BigInt(frames),
        fedFrames: 0n,
        sealed: true,
        target: BigInt(frames),
        inputEnd: BigInt(frames),
      });
      await attachment.start(profile(receiver), item);
      const { all, result } = await rendered(
        stream,
        receiver,
        frames,
        new Map([[highSource, source]]),
      );
      assertEquals(result.pcm.subarray(0, frames * 4), source);
      assertEquals(
        result.pcm.subarray(frames * 4),
        new Uint8Array(result.pcm.length - frames * 4),
      );
      assertEquals(
        all.filter((r) => r.kind === 'real').reduce((n, r) => n + r.frames, 0n),
        BigInt(frames),
      );
      assertEquals(
        all.filter((r) => r.kind === 'padding').reduce(
          (n, r) => n + r.frames,
          0n,
        ),
        BigInt((352 - frames % 352) % 352),
      );
      assertEquals(
        (await stream.source(stream.epoch, highSource))!.fedFrames,
        BigInt(frames),
      );
      assert(
        all.some((r) => r.kind === 'drain' && r.frames > 44100n),
        'paced drain persists through the receiver schedule',
      );
      await libraryProof();
    } finally {
      await stream.close();
      receiver.close();
    }
  });
}

test('partial accepted source prefix is copied and only its exact suffix is retried', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  const source = pcm(88200 + 137, 456);
  const original = source.slice();
  try {
    const first = await stream.appendSource({
      epoch: stream.epoch,
      source: highSource,
      segment: 99n,
      pcm: source,
    });
    assertEquals([
      first.status,
      first.acceptedFrames,
      first.sourceOffset,
      first.inputOffset,
    ], ['backpressure', 88200n, 0n, 0n]);
    const suffix = source.subarray(88200 * 4).slice();
    const full = await stream.appendSource({
      epoch: stream.epoch,
      source: highSource,
      segment: 99n,
      pcm: suffix,
    });
    assertEquals([
      full.status,
      full.acceptedFrames,
      full.sourceOffset,
      full.inputOffset,
    ], ['backpressure', 0n, 88200n, 88200n]);
    source.fill(0x6d, 0, 88200 * 4);
    await attachment.start(profile(receiver), item);
    await append(stream, highSource, suffix, 99n);
    await stream.seal(stream.epoch, highSource, 88337n);
    await stream.endStream(stream.epoch, 88337n);
    const { result } = await rendered(
      stream,
      receiver,
      88337,
      new Map([[highSource, original]]),
    );
    assertEquals(result.pcm.subarray(0, original.length), original);
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

test('same-epoch 353/351 seals concatenate inside a packet without padding or FLUSH', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const a = pcm(353), b = pcm(351, 777);
  const attachment = stream.attach(() => {});
  try {
    await append(stream, 1n, a, 11n);
    assertEquals((await stream.seal(stream.epoch, 1n, 353n)).inputEnd, 353n);
    await append(stream, 2n, b, 22n);
    assertEquals((await stream.seal(stream.epoch, 2n, 351n)).inputEnd, 704n);
    assertEquals(
      (await stream.endStream(stream.epoch, 704n)).status,
      'accepted',
    );
    await attachment.start(profile(receiver), item);
    const { all, result } = await rendered(
      stream,
      receiver,
      704,
      new Map([[1n, a], [2n, b]]),
    );
    assertEquals(
      all.slice(0, 2).map((
        r,
      ) => [r.kind, r.source, r.segment, r.transportStart, r.frames]),
      [
        ['real', 1n, 11n, 0n, 353n],
        ['real', 2n, 22n, 353n, 351n],
      ],
    );
    const expected = new Uint8Array(704 * 4);
    expected.set(a);
    expected.set(b, a.length);
    assertEquals(result.pcm.subarray(0, expected.length), expected);
    assertEquals(
      all.filter((r) => r.kind === 'padding' || r.kind === 'underrun'),
      [],
    );
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

test('real underrun advances labeled transport silence but freezes source accounting', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  const a = pcm(353), b = pcm(351, 313);
  try {
    await attachment.start(profile(receiver), item);
    await sleep(50);
    assertEquals(
      receiver.sessions[0]?.audioPackets,
      0,
      'ready transport without real input never anchors',
    );
    assertEquals(await stream.range(stream.epoch, 0n), null);
    await append(stream, 1n, a);
    await until(
      'first source fed',
      async () => (await stream.source(stream.epoch, 1n))?.fedFrames === 353n,
    );
    await sleep(100);
    const frozen = await stream.source(stream.epoch, 1n);
    assertEquals([frozen!.acceptedFrames, frozen!.fedFrames, frozen!.sealed], [
      353n,
      353n,
      false,
    ]);
    assert(
      (await ranges(stream)).some((r) =>
        r.kind === 'underrun' && r.frames >= 4410n
      ),
    );
    await append(stream, 1n, b, 2n);
    await stream.seal(stream.epoch, 1n, 704n);
    await stream.endStream(stream.epoch, 704n);
    await until(
      'resumed source fed',
      async () => (await stream.source(stream.epoch, 1n))?.fedFrames === 704n,
    );
    const all = await ranges(stream);
    const real = all.filter((r) => r.kind === 'real');
    assertEquals(real.map((r) => [r.sourceOffset, r.frames]), [[0n, 353n], [
      353n,
      351n,
    ]]);
    const end = Number(real[1].transportStart + real[1].frames);
    const source = new Uint8Array(704 * 4);
    source.set(a);
    source.set(b, a.length);
    await rendered(stream, receiver, end, new Map([[1n, source]]));
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

test('exclusive immutable source/end targets reject late or unordered input without mutation', async () => {
  const stream = createFfiStream();
  try {
    await append(stream, highSource, pcm(1));
    assertEquals(
      (await stream.appendSource({
        epoch: stream.epoch,
        source: 2n,
        segment: 2n,
        pcm: pcm(1),
      })).status,
      'error',
    );
    assertEquals(
      (await stream.seal(stream.epoch, highSource, 2n)).status,
      'error',
    );
    assertEquals(
      (await stream.endStream(stream.epoch, 1n)).status,
      'error',
      'unsealed input cannot end',
    );
    const seal = await stream.seal(stream.epoch, highSource, 1n);
    assertEquals(
      (await stream.appendSource({
        epoch: stream.epoch,
        source: highSource,
        segment: 9n,
        pcm: pcm(1),
      })).status,
      'error',
    );
    await append(stream, 2n, pcm(1));
    await stream.seal(stream.epoch, 2n, 1n);
    assertEquals(
      await stream.seal(stream.epoch, highSource, 1n),
      seal,
      'later source cannot move an old seal',
    );
    assertEquals(
      (await stream.seal(stream.epoch, highSource, 0n)).status,
      'error',
    );
    assertEquals((await stream.endStream(stream.epoch, 1n)).status, 'error');
    const end = await stream.endStream(stream.epoch, 2n);
    assertEquals(end.status, 'accepted');
    assertEquals(await stream.endStream(stream.epoch, 2n), end);
    assertEquals((await stream.endStream(stream.epoch, 3n)).status, 'error');
    assertEquals(
      (await stream.appendSource({
        epoch: stream.epoch,
        source: 3n,
        segment: 3n,
        pcm: pcm(1),
      })).status,
      'error',
    );
    assertEquals(
      (await stream.append({ epoch: stream.epoch, segment: 1n, pcm: pcm(1) }))
        .status,
      'error',
      'unlabeled admission cannot bypass the ledger',
    );
    await assertRejects(
      () =>
        stream.appendSource({
          epoch: stream.epoch,
          source: 1n << 64n,
          segment: 1n,
          pcm: pcm(1),
        }),
      RangeError,
    );
    await assertRejects(() => stream.seal(stream.epoch, 2n, -1n), RangeError);
    const retained = await stream.source(stream.epoch, highSource);
    await assertRejects(
      () => stream.reset(),
      Error,
      'raop_stream_reset failed',
    );
    assertEquals(
      await stream.source(stream.epoch, highSource),
      retained,
      'legacy local reset cannot erase a sealed identity within the same epoch',
    );
    await libraryProof();
  } finally {
    await stream.close();
  }
});

for (const manySources of [true, false]) {
  test(`bounded ${manySources ? 'source markers' : 'segment ranges'} backpressure without dropping seals`, async () => {
    const stream = createFfiStream();
    try {
      let frames = 0n;
      for (let id = 1n; id <= 1000n; id++) {
        const r = await stream.appendSource({
          epoch: stream.epoch,
          source: manySources ? id : 1n,
          segment: id,
          pcm: pcm(1),
        });
        if (r.status === 'backpressure') {
          assertEquals(r.acceptedFrames, 0n);
          break;
        }
        assertEquals(r.status, 'accepted');
        frames++;
        if (manySources) {
          assertEquals(
            (await stream.seal(stream.epoch, id, 1n)).status,
            'accepted',
          );
        }
      }
      assert(
        frames > 16n && frames < 1000n,
        'bounded retained records, not the lossy state ring',
      );
      for (let id = 1n; id <= (manySources ? frames : 1n); id++) {
        const s = await stream.source(stream.epoch, id);
        assertEquals(s!.acceptedFrames, manySources ? 1n : frames);
      }
      if (!manySources) {
        assertEquals(
          (await stream.seal(stream.epoch, 1n, frames)).status,
          'accepted',
        );
      }
      assertEquals(
        (await stream.endStream(stream.epoch, frames)).status,
        'accepted',
        'closing markers have reserved storage',
      );
      const old = stream.epoch;
      assertEquals((await stream.cancel(old)).status, 'ready');
      assertEquals(await stream.source(old, 1n), null);
      assertEquals((await stream.seal(old, 1n, 1n)).status, 'canceled');
      await append(stream, 1n, pcm(1));
      assertEquals((await stream.source(stream.epoch, 1n))!.acceptedFrames, 1n);
      await stream.ackCancel(old);
      await libraryProof();
    } finally {
      await stream.close();
    }
    await assertRejects(
      () => stream.endStream(stream.epoch, 0n),
      Error,
      'closed',
    );
  });
}

test('cancel fences a sealed old tail and held FLUSH cannot erase the replacement', async () => {
  const stream = createFfiStream();
  const gate = Promise.withResolvers<void>();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
    beforeFlushReply: () => gate.promise,
  });
  const attachment = stream.attach(() => {});
  const old = stream.epoch;
  try {
    await append(stream, 1n, pcm(353));
    await stream.seal(old, 1n, 353n);
    await stream.endStream(old, 353n);
    await attachment.start(profile(receiver), item);
    await until(
      'old tail arrives',
      () => receiver.sessions[0]?.audioPackets >= 2,
    );
    const cancel = stream.cancel(old);
    await until('held FLUSH', () => receiver.sessions[0]?.flushes === 1);
    const replacement = pcm(351, 989);
    assertEquals(
      (await stream.appendSource({
        epoch: stream.epoch,
        source: 2n,
        segment: 2n,
        pcm: replacement,
      })).status,
      'not-ready',
    );
    assertEquals((await stream.seal(stream.epoch, 2n, 0n)).status, 'not-ready');
    assertEquals((await stream.endStream(old, 353n)).status, 'canceled');
    gate.resolve();
    assertEquals((await cancel).status, 'ready');
    await append(stream, 2n, replacement);
    await stream.seal(stream.epoch, 2n, 351n);
    await stream.endStream(stream.epoch, 351n);
    await until('replacement scheduled', () => {
      const r = renderScheduledAudio(receiver.sessions[0], receiver.nowMs());
      return r.ranges.some((range) => range.epoch === 2 && range.frames >= 352);
    });
    const result = renderScheduledAudio(receiver.sessions[0], receiver.nowMs());
    assertEquals(result.issues, []);
    const replacementRanges = result.ranges.filter((r) => r.epoch === 2);
    const bytes = new Uint8Array(
      replacementRanges.reduce((n, r) => n + r.pcm.length, 0),
    );
    let offset = 0;
    for (const r of replacementRanges) {
      bytes.set(r.pcm, offset);
      offset += r.pcm.length;
    }
    assertEquals(bytes.subarray(0, replacement.length), replacement);
    assertEquals(
      bytes.subarray(replacement.length),
      new Uint8Array(bytes.length - replacement.length),
    );
    assert(result.discarded.some((r) => r.reason === 'flush' && r.epoch === 1));
    accounted(bytes, await ranges(stream), new Map([[2n, replacement]]));
    assertEquals(await stream.source(old, 1n), null);
    await stream.ackCancel(old);
    await libraryProof();
  } finally {
    gate.resolve();
    await stream.close();
    receiver.close();
  }
});

test('empty end never anchors and raw ABI refuses malformed identities and frames', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  const lib = raopFfiInternals.loadLibrary();
  const raw = lib.symbols.raop_stream_new();
  assert(raw);
  try {
    const r = new BigUint64Array(8);
    for (
      const [source, segment, bytes] of [[0n, 1n, pcm(1)], [1n, 0n, pcm(1)], [
        1n,
        1n,
        new Uint8Array(1),
      ]] as const
    ) {
      assertEquals(
        lib.symbols.raop_stream_append_source(
          raw,
          1n,
          source,
          segment,
          bytes,
          BigInt(bytes.length),
          r,
        ),
        0,
      );
      assertEquals([r[3], r[6], r[7]], [0n, 3n, 1n]);
    }
    assertEquals((await stream.endStream(stream.epoch, 0n)).status, 'accepted');
    await attachment.start(profile(receiver), item);
    await sleep(100);
    assertEquals(receiver.sessions[0]?.audioPackets, 0);
    assertEquals(await stream.range(stream.epoch, 0n), null);
    await libraryProof();
  } finally {
    assertEquals(await lib.symbols.raop_stream_free(raw), 0);
    await stream.close();
    receiver.close();
  }
});
