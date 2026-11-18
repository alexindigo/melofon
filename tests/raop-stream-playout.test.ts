// Ordered timeline ingress -> shipping native library -> independently scheduled
// UDP/ALAC consumer. Scheduled progress is not a terminal completion receipt.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { createFfiStream, raopFfiInternals } from '../src/boots/raop-ffi.ts';
import {
  type AirplayCompletionKey,
  type AirplayRangeSnapshot,
  profileFromService,
} from '../src/boots/airplay-profile.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';

type Stream = ReturnType<typeof createFfiStream>;
type Receiver = Awaited<ReturnType<typeof startFakeRaop>>;
const key = (
  stream: Stream,
  source: bigint,
  target: bigint,
  revision = 1n,
): AirplayCompletionKey => ({ epoch: stream.epoch, source, target, revision });
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
      const identity = key(stream, highSource, BigInt(frames));
      const completed = await stream.waitCompletion(identity);
      assertEquals([
        completed.status,
        completed.target,
        completed.transportEnd,
        completed.required,
        completed.attachments[0].outcome,
      ], ['complete', BigInt(frames), BigInt(frames), 1n, 'complete']);
      assertEquals(await stream.pollCompletion(identity), completed);
      assert(
        completed.attachments[0].submittedFrames >= completed.transportEnd,
      );
      assert(
        completed.attachments[0].scheduledFrames >= completed.transportEnd,
      );
      const fed = (await stream.progress(stream.epoch))!.fedFrames;
      await sleep(50);
      assertEquals(
        (await stream.progress(stream.epoch))!.fedFrames,
        fed,
        'ended drain stops only after the retained scheduled completion',
      );
      await stream.ackCompletion(identity);
      assertEquals(await stream.pollCompletion(identity), null);
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

test('a paced partial packet survives an asynchronous same-stream source boundary', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  const a = pcm(353), b = pcm(351, 777);
  try {
    await attachment.start(profile(receiver), item);
    await append(stream, 1n, a);
    await until(
      'outgoing partial packet fed',
      async () => (await stream.source(stream.epoch, 1n))?.fedFrames === 353n,
    );
    await stream.seal(stream.epoch, 1n, 353n);
    // The next source is supplied after multiple pacer callbacks, but well
    // before the actual wire presentation deadline. A seal is not stream EOF.
    await sleep(50);
    await append(stream, 2n, b);
    await stream.seal(stream.epoch, 2n, 351n);
    await stream.endStream(stream.epoch, 704n);
    const { all, result } = await rendered(
      stream,
      receiver,
      704,
      new Map([[1n, a], [2n, b]]),
    );
    assertEquals(
      all.filter((r) => r.kind === 'real').map((
        r,
      ) => [r.source, r.transportStart, r.frames]),
      [[1n, 0n, 353n], [2n, 353n, 351n]],
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

test('delayed stream end pads only the final incomplete packet', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  const bytes = pcm(351);
  try {
    await attachment.start(profile(receiver), item);
    await append(stream, 1n, bytes);
    await until(
      'real tail retained before EOF',
      async () => (await stream.source(stream.epoch, 1n))?.fedFrames === 351n,
    );
    await stream.seal(stream.epoch, 1n, 351n);
    await sleep(50);
    assertEquals(receiver.sessions[0].audioPackets, 0);
    await stream.endStream(stream.epoch, 351n);
    const { all, result } = await rendered(
      stream,
      receiver,
      351,
      new Map([[1n, bytes]]),
    );
    assertEquals(result.pcm.subarray(0, bytes.length), bytes);
    assertEquals(
      all.filter((r) => r.kind === 'padding').map((
        r,
      ) => [r.transportStart, r.frames]),
      [[351n, 1n]],
    );
    assertEquals(all.filter((r) => r.kind === 'underrun'), []);
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
    await until(
      'actual presentation underrun',
      async () =>
        (await ranges(stream)).some((r) =>
          r.kind === 'underrun' && r.frames >= 4410n
        ),
    );
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
      if (manySources) {
        assertEquals(
          (await stream.appendSource({
            epoch: stream.epoch,
            source: 1n,
            segment: 1n,
            pcm: pcm(1),
          })).status,
          'backpressure',
          'unacked old terminal receipts retain marker capacity across cancel',
        );
        for (let source = 1n; source <= frames; source++) {
          await stream.ackCompletion({
            epoch: old,
            source,
            target: 1n,
            revision: 1n,
          });
        }
      }
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

async function progressChild(mode: string) {
  const directory = await Deno.makeTempDir({ prefix: 'raop-progress-' });
  const helper = new URL('../helper/raop/', import.meta.url).pathname;
  const interposer = `${directory}/progress.so`;
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
      `RAOP timeline: progress ${mode}`,
      new URL(import.meta.url).pathname,
    ],
    env: {
      LD_PRELOAD: interposer,
      RAOP_PROGRESS_CASE: mode,
      RAOP_PROGRESS_DIRECTORY: directory,
      RAOP_PROGRESS_ARM: `${directory}/arm`,
      RAOP_PROGRESS_HOLD: `${directory}/hold`,
      RAOP_PROGRESS_FAULT: mode,
      ...(mode === 'offsets and wrap' ? { RAOP_PROGRESS_WRAP: '1' } : {}),
    },
  }).output();
  await Deno.writeFile(`${directory}/child.stdout`, child.stdout);
  await Deno.writeFile(`${directory}/child.stderr`, child.stderr);
  const stdout = new TextDecoder().decode(child.stdout);
  assertEquals(child.code, 0, stdout + new TextDecoder().decode(child.stderr));
  assert(/1 passed.*0 failed/.test(stdout));
  for (const line of stdout.split('\n')) {
    if (line.startsWith('playout native library:')) console.log(line);
  }
}

for (
  const mode of [
    'held emission',
    'catchup',
    'offsets and wrap',
    'allocation',
    'encoder',
    'cipher',
    'send',
    'sync',
    'periodic sync',
    'overdue',
  ]
) {
  test(`progress ${mode}`, async () => {
    if (Deno.env.get('RAOP_PROGRESS_CASE') !== mode) {
      return await progressChild(mode);
    }
    const directory = Deno.env.get('RAOP_PROGRESS_DIRECTORY')!;
    const hold = `${directory}/hold`, arm = `${directory}/arm`;
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const attachment = stream.attach(() => {});
    const source = pcm(
      ['overdue', 'catchup'].includes(mode) ? 44100 : 704,
      347,
    );
    let second: Receiver | undefined;
    try {
      const empty = await stream.progress(stream.epoch, highSource);
      assertEquals([empty!.status, empty!.participants, empty!.sourceFrames], [
        'waiting',
        0n,
        0n,
      ]);
      if (mode === 'held emission') await Deno.writeTextFile(hold, 'hold');
      if (mode === 'offsets and wrap') {
        second = await startFakeRaop({ captureAudio: true, captureWire: true });
        const slow = stream.attach(() => {});
        const observer = Deno.dlopen(`${directory}/progress.so`, {
          raop_fi_offset: { parameters: ['u64', 'i32'], result: 'void' },
        });
        observer.symbols.raop_fi_offset(slow.id, 150);
        // Both are ready before real input; neither receiver owns the clock.
        await attachment.start(profile(receiver), item);
        await slow.start(profile(second), item);
        await append(stream, highSource, source);
        await stream.seal(stream.epoch, highSource, 704n);
        await stream.endStream(stream.epoch, 704n);
        await until(
          'fast receiver final source boundary',
          async () =>
            (await stream.progress(stream.epoch, highSource, attachment.id))!
              .sourceFrames === 704n,
        );
        const fast =
          (await stream.progress(stream.epoch, highSource, attachment.id))!;
        const peer =
          (await stream.progress(stream.epoch, highSource, slow.id))!;
        const group = (await stream.progress(stream.epoch, highSource))!;
        assertEquals(fast.status, 'scheduled');
        assertEquals(peer.scheduleOriginNs - fast.scheduleOriginNs, 150000000n);
        assertEquals(group.participants, 2n);
        assert(
          group.sourceFrames < 704n,
          'group cannot use the faster boundary',
        );
        assert(peer.sourceFrames < fast.sourceFrames);
        assertEquals(
          (await stream.pollCompletion(key(stream, highSource, 704n)))!.status,
          'pending',
        );
        await until(
          'slow group final source boundary',
          async () =>
            (await stream.progress(stream.epoch, highSource))!.sourceFrames ===
              704n,
        );
        await rendered(stream, receiver, 704, new Map([[highSource, source]]));
        await rendered(stream, second, 704, new Map([[highSource, source]]));
        const wire = receiver.sessions[0].wire.filter((e) =>
          e.kind === 'audio'
        );
        assert(wire.length > 2);
        assert(receiver.sessions[0].rtpSequences.includes(65535));
        assert(receiver.sessions[0].rtpSequences.includes(0));
        const timestamps = wire.map((e) => {
          assert('data' in e);
          return new DataView(
            e.data.buffer,
            e.data.byteOffset,
            e.data.byteLength,
          ).getUint32(4);
        });
        assert(
          timestamps.some((value, i) => i > 0 && value < timestamps[i - 1]),
          'actual wire RTP timestamp wrapped',
        );
        // The independent renderer extends both wrapping counters; exact PCM
        // plus wide native submission proves neither counter is an identity.
        const final = (await stream.progress(stream.epoch, highSource))!;
        assert(final.submittedFrames > 65536n);
        assertEquals(final.sourceFrames, 704n);
        const complete = await stream.waitCompletion(
          key(stream, highSource, 704n),
        );
        assertEquals(complete.status, 'complete');
        assertEquals(complete.required, 2n);
        assert(complete.attachments.every((a) => a.outcome === 'complete'));
        await libraryProof();
        observer.close();
        return;
      }
      await append(stream, highSource, source);
      await stream.seal(stream.epoch, highSource, BigInt(source.length / 4));
      await stream.endStream(stream.epoch, BigInt(source.length / 4));
      if (['allocation', 'encoder', 'cipher', 'send', 'sync'].includes(mode)) {
        await Deno.writeTextFile(arm, 'fail next matching real dependency');
      }
      await attachment.start({
        ...profile(receiver),
        encrypt: mode === 'cipher',
        // Native Apple TV 1 explicitly disables encryption regardless of ek.
        // Use the generic encrypted RAOP branch to reach the real AES call.
        devtype: mode === 'cipher' ? 'other' : 'appletv',
      }, item);
      if (mode === 'catchup') {
        await until(
          'initial packet before recoverable stall',
          () => receiver.sessions[0]?.audioPackets > 0,
        );
        await Deno.writeTextFile(hold, 'hold inside actual presentation lead');
        await sleep(200);
        await Deno.remove(hold);
        await rendered(
          stream,
          receiver,
          44100,
          new Map([[highSource, source]]),
        );
        const progress = (await stream.progress(stream.epoch, highSource))!;
        assertEquals([progress.status, progress.error, progress.sourceFrames], [
          'scheduled',
          'none',
          44100n,
        ]);
      } else if (mode === 'held emission') {
        await sleep(2500); // Longer than the old accepted-EOF/latency estimate.
        const held = (await stream.progress(stream.epoch, highSource))!;
        assertEquals([
          held.sourceFrames,
          held.scheduledFrames,
          held.submittedFrames,
          held.fedFrames,
          receiver.sessions[0].audioPackets,
        ], [0n, 0n, 0n, 0n, 0]);
        assertEquals(
          (await stream.source(stream.epoch, highSource))!.acceptedFrames,
          704n,
        );
        const identity = key(stream, highSource, 704n);
        assertEquals(
          (await stream.pollCompletion(identity))!.status,
          'pending',
        );
        await assertRejects(
          () => stream.ackCompletion(identity),
          Error,
          'pending',
        );
        await Deno.remove(hold);
        await rendered(stream, receiver, 704, new Map([[highSource, source]]));
        const progress = (await stream.progress(stream.epoch, highSource))!;
        assertEquals([
          progress.status,
          progress.error,
          progress.sourceFrames,
          progress.realFrames,
        ], ['scheduled', 'none', 704n, 704n]);
        assert(progress.silenceFrames > 0n);
        assertEquals(
          progress.realFrames + progress.silenceFrames,
          progress.scheduledFrames,
        );
        const completed = await stream.waitCompletion(identity);
        assertEquals(completed.status, 'complete');
        assertEquals(completed.attachments[0].outcome, 'complete');
        assertEquals(await stream.pollCompletion(identity), completed);
        await stream.ackCompletion(identity);
      } else {
        if (mode === 'overdue' || mode === 'periodic sync') {
          await until(
            'first submitted packet',
            () => receiver.sessions[0]?.audioPackets > 0,
          );
          if (mode === 'overdue') {
            await Deno.writeTextFile(hold, 'hold actual timer expirations');
            const held = (await stream.progress(stream.epoch, highSource))!;
            await sleep(2600);
            const covered = (await stream.progress(stream.epoch, highSource))!;
            assertEquals(covered.status, 'scheduled');
            assertEquals(covered.submittedFrames, held.submittedFrames);
            assert(covered.sourceFrames <= covered.submittedFrames);
            assert(
              covered.sourceFrames < BigInt(source.length / 4),
              'elapsed time cannot credit unsubmitted EOF',
            );
            await Deno.remove(hold);
          } else {
            Deno.env.set('RAOP_PROGRESS_FAULT', 'sync');
            // libc getenv observes process environment set by Deno.env.set.
            await Deno.writeTextFile(arm, 'fail periodic wire sync');
          }
        }
        await until(
          'explicit retained epoch failure',
          async () =>
            (await stream.progress(stream.epoch, highSource))?.status ===
              'failed',
        );
        const failure = (await stream.progress(stream.epoch, highSource))!;
        assertEquals(failure.error, mode === 'periodic sync' ? 'sync' : mode);
        assert(failure.sourceFrames < BigInt(source.length / 4));
        assertEquals(failure.sourceFrames, failure.realFrames);
        const identity = key(stream, highSource, BigInt(source.length / 4));
        const failed = await stream.waitCompletion(identity);
        assertEquals([failed.status, failed.error], ['failed', failure.error]);
        assert(failed.attachments.some((a) => a.outcome === 'failed'));
        await sleep(100);
        assertEquals(
          await stream.progress(stream.epoch, highSource),
          failure,
          'failure is retained outside the state ring, with frozen proven prefix',
        );
        if (
          ['allocation', 'encoder', 'cipher', 'send', 'sync'].includes(mode)
        ) {
          assertEquals([
            failure.sourceFrames,
            receiver.sessions[0].audioPackets,
          ], [0n, 0]);
        } else if (mode === 'overdue') {
          assertEquals(
            receiver.sessions[0].audioPackets * 352,
            Number(failure.submittedFrames),
            'no overdue packet was emitted, not just no credited progress',
          );
          const replay = renderScheduledAudio(
            receiver.sessions[0],
            receiver.nowMs(),
          );
          assertEquals(replay.issues, []);
          assertEquals(replay.pcm.length / 4, Number(failure.sourceFrames));
          assertEquals(replay.pcm, source.subarray(0, replay.pcm.length));
        }
        assertEquals(
          (await stream.appendSource({
            epoch: stream.epoch,
            source: 2n,
            segment: 2n,
            pcm: pcm(1),
          })).status,
          'error',
        );
        const old = stream.epoch;
        assertEquals((await stream.cancel(old)).status, 'ready');
        assertEquals(
          await stream.pollCompletion(identity),
          failed,
          'old terminal source failure survives cancellation unchanged',
        );
        await stream.ackCompletion(identity);
        assertEquals(await stream.progress(old, highSource), null);
        assertEquals((await stream.progress(stream.epoch))!.error, 'none');
        await stream.ackCancel(old);
      }
      await libraryProof();
    } finally {
      try {
        await Deno.remove(hold);
      } catch { /* not armed */ }
      await stream.close();
      receiver.close();
      second?.close();
    }
  });
}

test('scheduled source position freezes across real underrun and excludes every silence range', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  const a = pcm(353), b = pcm(351, 987);
  try {
    await attachment.start(profile(receiver), item);
    await append(stream, highSource, a);
    await until(
      'first real prefix scheduled',
      async () =>
        (await stream.progress(stream.epoch, highSource))!.sourceFrames ===
          353n,
    );
    const first = (await stream.progress(stream.epoch, highSource))!;
    await sleep(100);
    const starved = (await stream.progress(stream.epoch, highSource))!;
    assertEquals(starved.sourceFrames, first.sourceFrames);
    assert(starved.silenceFrames > first.silenceFrames);
    assert(starved.scheduledFrames > first.scheduledFrames);
    const before = receiver.nowMs();
    const observed = (await stream.progress(stream.epoch, highSource))!;
    const after = receiver.nowMs();
    const snapshot = renderScheduledAudio(receiver.sessions[0], after);
    assertEquals(snapshot.issues, []);
    const uncertainty = snapshot.clockUncertaintyMs! + 1;
    const lower =
      renderScheduledAudio(receiver.sessions[0], before - uncertainty).pcm
        .length / 4;
    const upper =
      renderScheduledAudio(receiver.sessions[0], after + uncertainty).pcm
        .length / 4;
    assert(
      Number(observed.scheduledFrames) >= lower &&
        Number(observed.scheduledFrames) <= upper,
      `native boundary ${observed.scheduledFrames} is inside independent wire-clock interval ${lower}..${upper}`,
    );
    await append(stream, highSource, b, 2n);
    await stream.seal(stream.epoch, highSource, 704n);
    await stream.endStream(stream.epoch, 704n);
    await until(
      'resumed source scheduled',
      async () =>
        (await stream.progress(stream.epoch, highSource))!.sourceFrames ===
          704n,
    );
    const source = new Uint8Array(704 * 4);
    source.set(a);
    source.set(b, a.length);
    const real = (await ranges(stream)).filter((r) => r.kind === 'real');
    await rendered(
      stream,
      receiver,
      Number(real[1].transportStart + real[1].frames),
      new Map([[highSource, source]]),
    );
    const pending = stream.progress(stream.epoch, highSource);
    const closing = stream.close();
    assertEquals((await pending)!.sourceFrames, 704n);
    await closing; // C1 joins the loop-dispatched native reader before C3 free.
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

test('scheduled ranges project each sealed source without double-counting a shared packet', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  const a = pcm(353), b = pcm(351, 321);
  try {
    await append(stream, 1n, a);
    await stream.seal(stream.epoch, 1n, 353n);
    await append(stream, highSource, b);
    await stream.seal(stream.epoch, highSource, 351n);
    await stream.endStream(stream.epoch, 704n);
    await attachment.start(profile(receiver), item);
    await until(
      'accepted EOF dispatched but not yet presented',
      async () =>
        (await stream.source(stream.epoch, highSource))!.fedFrames === 351n,
    );
    assertEquals(
      (await stream.progress(stream.epoch, highSource))!.sourceFrames,
      0n,
    );
    assertEquals(
      renderScheduledAudio(receiver.sessions[0], receiver.nowMs()).pcm.length,
      0,
    );
    await rendered(stream, receiver, 704, new Map([[1n, a], [highSource, b]]));
    const first = (await stream.progress(stream.epoch, 1n))!;
    const second = (await stream.progress(stream.epoch, highSource))!;
    assertEquals([
      first.sourceFrames,
      second.sourceFrames,
      first.realFrames,
      second.realFrames,
    ], [353n, 351n, 704n, 704n]);
    assertEquals(first.realFrames + first.silenceFrames, first.scheduledFrames);
    assert(Object.isFrozen(first));
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

test('completion retains more than sixteen exact terminal results across polling delays and cancel', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  const sources = new Map<bigint, Uint8Array>();
  const identities: AirplayCompletionKey[] = [];
  try {
    for (let i = 1n; i <= 24n; i++) {
      const bytes = pcm(1, Number(i));
      sources.set(i, bytes);
      await append(stream, i, bytes);
      await stream.seal(stream.epoch, i, 1n);
      identities.push(key(stream, i, 1n));
    }
    await stream.endStream(stream.epoch, 24n);
    const pending = await stream.pollCompletion(identities[23]);
    assertEquals(pending!.status, 'pending');
    assertEquals(pending!.transportEnd, 0n);
    await assertRejects(
      () => stream.ackCompletion(identities[23]),
      Error,
      'pending',
    );
    await attachment.start(profile(receiver), item);
    // Deliberately do not poll during playout: source receipts are not events in
    // the 16-entry device ring and do not depend on a consumer keeping up.
    await rendered(stream, receiver, 24, sources);
    const results = [];
    for (let i = 0; i < identities.length; i++) {
      const result = await stream.waitCompletion(identities[i]);
      assertEquals([
        result.streamId,
        result.status,
        result.inputEnd,
        result.transportEnd,
      ], [stream.id, 'complete', BigInt(i + 1), BigInt(i + 1)]);
      assertEquals(result.attachments.map((a) => a.attachment), [
        attachment.id,
      ]);
      assert(
        Object.isFrozen(result) && Object.isFrozen(result.attachments) &&
          Object.isFrozen(result.attachments[0]),
      );
      results.push(result);
    }
    const old = stream.epoch;
    await stream.cancel(old);
    for (let i = 0; i < identities.length; i++) {
      assertEquals(await stream.pollCompletion(identities[i]), results[i]);
    }
    for (
      const change of [{ target: 2n }, { epoch: stream.epoch }, {
        revision: 2n,
      }, { source: 99n }]
    ) {
      await assertRejects(
        () => stream.ackCompletion({ ...identities[0], ...change }),
        Error,
        'ack refused',
      );
    }
    // Same opaque source in a new epoch cannot coalesce with the old terminal.
    await append(stream, 1n, pcm(351, 17));
    await stream.seal(stream.epoch, 1n, 351n);
    const fresh = key(stream, 1n, 351n);
    assertEquals((await stream.pollCompletion(fresh))!.status, 'pending');
    for (const identity of identities) await stream.ackCompletion(identity);
    assertEquals(await stream.pollCompletion(identities[0]), null);
    assertEquals((await stream.pollCompletion(fresh))!.status, 'pending');
    await stream.cancel(stream.epoch);
    const canceled = await stream.waitCompletion(fresh);
    assertEquals(canceled.status, 'canceled');
    assertEquals(canceled.attachments[0].outcome, 'canceled');
    assertEquals(await stream.pollCompletion(fresh), canceled);
    await stream.ackCompletion(fresh);
    await stream.ackCancel(old);
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

test('completion ack reclaims bounded source, input and silence ranges during a continuous epoch', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  const positions: { end: bigint; bytes: Uint8Array }[] = [];
  try {
    await attachment.start(profile(receiver), item);
    for (let batch = 0; batch < 4; batch++) {
      const identities = [];
      for (let n = 1; n <= 90; n++) {
        const source = BigInt(batch * 90 + n);
        const bytes = pcm(1, Number(source));
        await append(stream, source, bytes);
        await stream.seal(stream.epoch, source, 1n);
        identities.push(key(stream, source, 1n));
      }
      if (batch === 3) await stream.endStream(stream.epoch, 360n);
      assertEquals(
        (await stream.waitCompletion(identities[89])).status,
        'complete',
      );
      for (const identity of identities) {
        const result = await stream.waitCompletion(identity);
        positions.push({
          end: result.transportEnd,
          bytes: pcm(1, Number(identity.source)),
        });
        // Retain the first source while acknowledging later sources: silence
        // ownership cannot be inferred from the remaining real neighbors.
        if (identity.source === 1n) continue;
        await stream.ackCompletion(identity);
        assertEquals(await stream.source(stream.epoch, identity.source), null);
        assertEquals(await stream.pollCompletion(identity), null);
      }
      await sleep(30); // A real underrun after ack must not acquire a surviving neighbor's owner.
      let retainedRanges = 0n;
      while (await stream.range(stream.epoch, retainedRanges)) retainedRanges++;
      assert(
        retainedRanges <= 3n,
        'orphan silence cannot accumulate behind an unacked prefix',
      );
    }
    const final = positions[positions.length - 1].end;
    await until(
      'all final packet padding scheduled',
      () =>
        BigInt(
          renderScheduledAudio(receiver.sessions[0], receiver.nowMs()).pcm
            .length / 4,
        ) >= (final + 351n) / 352n * 352n,
    );
    const rendered = renderScheduledAudio(
      receiver.sessions[0],
      receiver.nowMs(),
    );
    assertEquals(rendered.issues, []);
    assertEquals(rendered.discarded, []);
    const expected = new Uint8Array(rendered.pcm.length);
    for (const { end, bytes } of positions) {
      expected.set(bytes, Number(end - 1n) * 4);
    }
    assertEquals(
      rendered.pcm,
      expected,
      'all 360 acknowledged sources once; every other transport byte zero',
    );
    assertEquals([
      receiver.sessions.length,
      receiver.sessions[0].flushes,
      receiver.sessions[0].teardowns,
    ], [1, 0, 0]);
    await stream.ackCompletion(key(stream, 1n, 1n));
    assertEquals(await stream.source(stream.epoch, 1n), null);
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

for (const loss of ['withdrawal', 'transport failure'] as const) {
  test(`completion cohort ${loss} is retained and only explicit revision can exclude it`, async () => {
    const stream = createFfiStream();
    const healthy = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const lost = await startFakeRaop({ captureAudio: true, captureWire: true });
    const peer = stream.attach(() => {}), departing = stream.attach(() => {});
    const bytes = pcm(353, 9);
    const identity = key(stream, highSource, 353n);
    let late: Receiver | undefined;
    try {
      await peer.start(profile(healthy), item);
      await departing.start(profile(lost), item);
      await append(stream, highSource, bytes);
      await stream.seal(stream.epoch, highSource, 353n);
      await stream.endStream(stream.epoch, 353n);
      await until(
        'both peers received the whole source, not yet scheduled',
        () =>
          healthy.sessions[0]?.audioPackets >= 2 &&
          lost.sessions[0]?.audioPackets >= 2,
      );
      assertEquals((await stream.pollCompletion(identity))!.status, 'pending');
      await assertRejects(
        () => stream.reviseCompletion(identity, [peer.id]),
        Error,
        'revision refused',
      );
      if (loss === 'withdrawal') await departing.transport.close();
      else lost.close();
      const failed = await stream.waitCompletion(identity);
      assertEquals(failed.status, 'failed');
      const excluded = failed.attachments.find((a) =>
        a.attachment === departing.id
      )!;
      assertEquals(
        excluded.outcome,
        loss === 'withdrawal' ? 'withdrawn' : 'failed',
      );
      assertEquals(excluded.excluded, false);
      await assertRejects(
        () => stream.reviseCompletion(identity, [departing.id, departing.id]),
        Error,
        'revision refused',
      );
      await assertRejects(
        () => stream.reviseCompletion(identity, [9999n]),
        Error,
        'revision refused',
      );
      const revised = await stream.reviseCompletion(identity, [departing.id]);
      assertEquals(revised, { ...identity, revision: 2n });
      if (loss === 'withdrawal') {
        late = await startFakeRaop({ captureAudio: true, captureWire: true });
        const joined = stream.attach(() => {});
        await joined.start(profile(late), item);
        await until(
          'late join has suffix coverage',
          async () =>
            (await stream.progress(stream.epoch, highSource, joined.id))!
              .coverageStart > 353n,
        );
        assertEquals(
          (await stream.progress(stream.epoch, highSource, joined.id))!
            .sourceFrames,
          0n,
        );
      }
      const complete = await stream.waitCompletion(revised);
      assertEquals([
        complete.status,
        complete.target,
        complete.inputEnd,
        complete.required,
      ], ['complete', 353n, 353n, 1n]);
      assertEquals(
        complete.attachments.length,
        2,
        'a late join never extends a sealed cohort',
      );
      assertEquals(
        complete.attachments.find((a) => a.attachment === peer.id)!.outcome,
        'complete',
      );
      assertEquals(
        complete.attachments.find((a) => a.attachment === departing.id)!
          .outcome,
        excluded.outcome,
      );
      assertEquals(
        complete.attachments.find((a) => a.attachment === departing.id)!
          .excluded,
        true,
      );
      assertEquals(
        await stream.pollCompletion(identity),
        failed,
        'original failed revision is immutable',
      );
      await rendered(stream, healthy, 353, new Map([[highSource, bytes]]));
      assertEquals(
        renderScheduledAudio(lost.sessions[0], lost.nowMs()).pcm.length,
        0,
        'departed peer was not credited with unheard scheduled audio',
      );
      await stream.ackCompletion(identity);
      assertEquals(await stream.pollCompletion(revised), complete);
      await stream.ackCompletion(revised);
      await libraryProof();
    } finally {
      await stream.close();
      healthy.close();
      lost.close();
      late?.close();
    }
  });
}

test('completion never succeeds with no captured participants, empty source or all exclusions', async () => {
  const stream = createFfiStream();
  try {
    await append(stream, 1n, pcm(1));
    await stream.seal(stream.epoch, 1n, 1n);
    const absent = await stream.waitCompletion(key(stream, 1n, 1n));
    assertEquals([absent.status, absent.required, absent.attachments.length], [
      'failed',
      0n,
      0,
    ]);
    await append(stream, 2n, new Uint8Array());
    await stream.seal(stream.epoch, 2n, 0n);
    assertEquals(
      (await stream.waitCompletion(key(stream, 2n, 0n))).status,
      'failed',
    );
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    try {
      const only = stream.attach(() => {});
      await append(stream, 3n, pcm(1));
      await stream.seal(stream.epoch, 3n, 1n);
      const identity = key(stream, 3n, 1n);
      await only.transport.close();
      assertEquals((await stream.waitCompletion(identity)).status, 'failed');
      const revised = await stream.reviseCompletion(identity, [only.id]);
      const none = await stream.waitCompletion(revised);
      assertEquals([none.status, none.required, none.attachments[0].excluded], [
        'failed',
        0n,
        true,
      ]);
      await stream.ackCompletion(identity);
      await stream.ackCompletion(revised);
      await libraryProof();
    } finally {
      receiver.close();
    }
  } finally {
    await stream.close();
  }
});

test('completion close cancels and joins admitted polls/waits before attachment and stream release', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const attachment = stream.attach(() => {});
  try {
    await append(stream, highSource, pcm(353));
    await stream.seal(stream.epoch, highSource, 353n);
    const identity = key(stream, highSource, 353n);
    await attachment.start(profile(receiver), item);
    const waiting = stream.waitCompletion(identity);
    const reading = stream.pollCompletion(identity);
    const closing = stream.close();
    assertEquals(stream.close(), closing);
    const canceled = await waiting;
    assertEquals(canceled.status, 'canceled');
    assertEquals(canceled.attachments[0].outcome, 'canceled');
    assertEquals((await reading)!.status, 'canceled');
    await closing;
    await assertRejects(() => stream.pollCompletion(identity), Error, 'closed');
    await assertRejects(() => stream.ackCompletion(identity), Error, 'closed');
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

test('completion late-join captured at seal fails missing prefix instead of crediting past audio', async () => {
  const stream = createFfiStream();
  const healthy = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const late = await startFakeRaop({ captureAudio: true, captureWire: true });
  const original = stream.attach(() => {}), joined = stream.attach(() => {});
  const bytes = pcm(353, 67);
  try {
    await original.start(profile(healthy), item);
    await append(stream, highSource, bytes);
    await until(
      'source dispatched before late receiver starts',
      async () =>
        (await stream.source(stream.epoch, highSource))!.fedFrames === 353n,
    );
    await joined.start(profile(late), item);
    await until(
      'late receiver has an explicit suffix anchor',
      async () =>
        (await stream.progress(stream.epoch, highSource, joined.id))!
          .coverageStart > 0n,
    );
    await stream.seal(stream.epoch, highSource, 353n);
    await stream.endStream(stream.epoch, 353n);
    const identity = key(stream, highSource, 353n);
    const failed = await stream.waitCompletion(identity);
    assertEquals(failed.status, 'failed');
    assertEquals(
      failed.attachments.find((a) => a.attachment === joined.id)!.outcome,
      'failed',
    );
    const revised = await stream.reviseCompletion(identity, [joined.id]);
    assertEquals((await stream.waitCompletion(revised)).status, 'complete');
    await rendered(stream, healthy, 353, new Map([[highSource, bytes]]));
    const suffix = renderScheduledAudio(late.sessions[0], late.nowMs());
    assertEquals(suffix.issues, []);
    const joinedOutcome = failed.attachments.find((a) =>
      a.attachment === joined.id
    )!;
    const expected = new Uint8Array(suffix.pcm.length);
    if (joinedOutcome.coverageStart < 353n) {
      expected.set(bytes.subarray(Number(joinedOutcome.coverageStart) * 4));
    }
    assertEquals(
      suffix.pcm,
      expected,
      'only the declared packet suffix, never the missed prefix',
    );
    assertEquals(await stream.pollCompletion(identity), failed);
    await libraryProof();
  } finally {
    await stream.close();
    healthy.close();
    late.close();
  }
});

for (const heldFrames of [4410n, 110250n]) {
  test(`late-join first sync retains RECORD anchor while master advances ${heldFrames} frames`, async () => {
    const stream = createFfiStream();
    const reply = Promise.withResolvers<void>();
    let entered = false;
    const healthy = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const late = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
      beforeRecordReply: () => {
        entered = true;
        return reply.promise;
      },
    });
    const original = stream.attach(() => {}), joined = stream.attach(() => {});
    const bytes = pcm(353, 71);
    let starting: Promise<void> | undefined;
    try {
      await original.start(profile(healthy), item);
      await append(stream, highSource, bytes);
      await until(
        'original source is dispatched before join',
        async () =>
          (await stream.source(stream.epoch, highSource))!.fedFrames === 353n,
      );
      starting = joined.start(profile(late), item);
      await until('late RECORD reply is held', () => entered);
      const before =
        (await stream.progress(stream.epoch, highSource))!.fedFrames;
      await until(
        'master advances while late RECORD is held',
        async () =>
          (await stream.progress(stream.epoch, highSource))!.fedFrames >=
            before + heldFrames,
      );
      reply.resolve();
      await starting;
      await until(
        'late first sync and audio arrive',
        () =>
          late.sessions[0].wire.some((e) => e.kind === 'control') &&
          late.sessions[0].audioPackets > 0,
      );
      const record = late.sessions[0].wire.find((e) => e.kind === 'record');
      const firstSync = late.sessions[0].wire.find((e) => e.kind === 'control');
      assert(record?.kind === 'record' && firstSync?.kind === 'control');
      assertEquals(firstSync.data[0], 0x90);
      assertEquals(
        new DataView(firstSync.data.buffer, firstSync.data.byteOffset)
          .getUint32(16),
        Number(/rtptime=(\d+)/.exec(record.rtpInfo)![1]),
        'first sync uses this receiver RTSP anchor, not the later shared position',
      );
      await stream.seal(stream.epoch, highSource, 353n);
      await stream.endStream(stream.epoch, 353n);
      const identity = key(stream, highSource, 353n);
      const failed = await stream.waitCompletion(identity);
      assertEquals(failed.status, 'failed');
      const outcome = failed.attachments.find((a) =>
        a.attachment === joined.id
      )!;
      assertEquals(outcome.outcome, 'failed');
      assert(
        outcome.coverageStart >= 353n,
        'late receiver cannot credit missed source',
      );
      const revised = await stream.reviseCompletion(identity, [joined.id]);
      assertEquals((await stream.waitCompletion(revised)).status, 'complete');
      await rendered(stream, healthy, 353, new Map([[highSource, bytes]]));
      await until(
        'late packet is independently scheduled',
        () =>
          renderScheduledAudio(late.sessions[0], late.nowMs()).pcm.length >=
            352 * 4,
      );
      const suffix = renderScheduledAudio(late.sessions[0], late.nowMs());
      assertEquals(suffix.issues, []);
      assertEquals(suffix.discarded, []);
      assertEquals(suffix.pcm, new Uint8Array(suffix.pcm.length));
      assertEquals(await stream.pollCompletion(identity), failed);
      await libraryProof();
    } finally {
      reply.resolve();
      await starting?.catch(() => {});
      await stream.close();
      healthy.close();
      late.close();
    }
  });
}

test('completion revised failure cannot wait forever for an unsubmitted healthy suffix', async () => {
  const stream = createFfiStream();
  const healthy = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  const lost = await startFakeRaop({ captureAudio: true, captureWire: true });
  const a = stream.attach(() => {}), b = stream.attach(() => {});
  try {
    await a.start(profile(healthy), item);
    await b.start(profile(lost), item);
    await append(stream, highSource, pcm(44100));
    await stream.seal(stream.epoch, highSource, 44100n);
    const identity = key(stream, highSource, 44100n);
    await until(
      'initial packets before source fully submitted',
      () =>
        healthy.sessions[0]?.audioPackets > 0 &&
        lost.sessions[0]?.audioPackets > 0,
    );
    lost.close();
    assertEquals((await stream.waitCompletion(identity)).status, 'failed');
    const revised = await stream.reviseCompletion(identity, [b.id]);
    const result = await stream.waitCompletion(revised);
    assertEquals(result.status, 'failed');
    assertEquals(
      result.attachments.find((peer) => peer.attachment === a.id)!.outcome,
      'failed',
    );
    assertEquals((await stream.cancel(stream.epoch)).status, 'ready');
    assertEquals(await stream.pollCompletion(revised), result);
    await libraryProof();
  } finally {
    await stream.close();
    healthy.close();
    lost.close();
  }
});

test('completion failed RECORD settles the captured source before any PCM submission', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
    refuseRecord: () => true,
  });
  const attachment = stream.attach(() => {});
  try {
    await append(stream, highSource, pcm(353));
    await stream.seal(stream.epoch, highSource, 353n);
    await attachment.start(profile(receiver), item);
    const failed = await stream.waitCompletion(key(stream, highSource, 353n));
    assertEquals([
      failed.status,
      failed.attachments[0].outcome,
      failed.attachments[0].submittedFrames,
    ], ['failed', 'failed', 0n]);
    assertEquals(receiver.sessions[0].audioPackets, 0);
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});
