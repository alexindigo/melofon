// b03a proves exact admission only. Ordered receiver cancellation belongs to
// b03b/b03c; no local reset receipt here is described as FLUSH readiness.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { createFfiStream, raopFfiInternals } from '../src/boots/raop-ffi.ts';
import { profileFromService } from '../src/boots/airplay-profile.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';

const cap = 2 * 44100;
const highSegment = 0xfedcba9876543210n;
const input = {
  volume: 50,
  positionMs: 0,
  lengthMs: 10000,
  title: '',
  artist: '',
};
type Receiver = Awaited<ReturnType<typeof startFakeRaop>>;
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(what: string, predicate: () => boolean) {
  const deadline = performance.now() + 15000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${what}`);
    await pause();
  }
}
function pcm(frames: number, seed = 0) {
  const bytes = new Uint8Array(frames * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, ((i * 17 + seed) % 30001) - 15000, true);
    view.setInt16(i * 4 + 2, 14000 - ((i * 19 + seed) % 28001), true);
  }
  return bytes;
}
function profile(receiver: Receiver) {
  return profileFromService({
    name: '001122334455@Admission._raop._tcp.local',
    host: 'fixture.local',
    address: '127.0.0.1',
    port: receiver.port,
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
    `admission native library: ${expected} sha256=${
      Array.from(hash, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
async function rendered(receiver: Receiver, expected: Uint8Array) {
  await until(
    'all packets and independent timing',
    () =>
      receiver.sessions[0]?.audioPackets === expected.length / (352 * 4) &&
      receiver.sessions[0].wire.some((event) => event.kind === 'timing-reply'),
  );
  const session = receiver.sessions[0];
  assertEquals(
    decodeReceiverAudio(session.sdp, session.audioPayloads),
    expected,
  );
  const pending = renderScheduledAudio(session, receiver.nowMs());
  assertEquals(pending.issues, []);
  assert(
    pending.lastPresentationAtMs !== null &&
      pending.clockUncertaintyMs !== null,
  );
  await until(
    'scheduled final real frame',
    () =>
      receiver.nowMs() >
        pending.lastPresentationAtMs! + pending.clockUncertaintyMs!,
  );
  const result = renderScheduledAudio(session, receiver.nowMs());
  assertEquals(result.issues, []);
  assertEquals(result.pcm, expected);
  assertEquals(result.pendingFrames, 0);
  assertEquals(result.discarded, []);
  assertEquals([session.flushes, session.teardowns, receiver.sessions.length], [
    0,
    0,
    1,
  ]);
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `RAOP admission: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

test('exact partial and zero receipts retry only the suffix through scheduled PCM', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  let ready = false;
  const attachment = stream.attach((event, value) => {
    if (event === 'state' && value === 'connected') ready = true;
  });
  const expected = pcm(251 * 352);
  const append = (segment: bigint, bytes: Uint8Array) =>
    stream.append({ epoch: stream.epoch, segment, pcm: bytes });
  try {
    const first = await append(highSegment, expected.subarray(0, 441 * 4));
    assertEquals(first, {
      streamId: stream.id,
      epoch: stream.epoch,
      segment: highSegment,
      acceptedFrames: 441n,
      status: 'accepted',
    });
    assert(Object.isFrozen(first));
    const partial = await append(highSegment + 1n, expected.subarray(441 * 4));
    assertEquals(partial, {
      streamId: stream.id,
      epoch: stream.epoch,
      segment: highSegment + 1n,
      acceptedFrames: BigInt(cap - 441),
      status: 'backpressure',
    });
    const suffix = expected.subarray(cap * 4);
    assertEquals((await append(highSegment + 1n, suffix)).acceptedFrames, 0n);
    assertEquals(
      (await append(highSegment + 1n, suffix)).status,
      'backpressure',
    );
    // The native ingress copied its prefix; mutating the caller's backing store
    // now must not mutate accepted audio. Keep only the unaccepted suffix.
    const retry = suffix.slice();
    expected.fill(0x6d, 0, cap * 4);
    const original = pcm(251 * 352);
    await attachment.start(profile(receiver), input);
    await until('attachment ready', () => ready);
    let offset = 0;
    while (offset < retry.length) {
      const receipt = await append(highSegment + 1n, retry.subarray(offset));
      assert(['accepted', 'backpressure'].includes(receipt.status));
      offset += Number(receipt.acceptedFrames) * 4;
      if (receipt.status === 'backpressure') await pause();
    }
    assertEquals(cap + offset / 4, original.length / 4);
    await rendered(receiver, original);
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

test('public native ABI preserves identities and refuses invalid or stale input without copying', async () => {
  const lib = raopFfiInternals.loadLibrary();
  const raw = lib.symbols.raop_stream_new();
  assert(raw);
  const epoch = lib.symbols.raop_stream_epoch(raw);
  assert(epoch > 0n);
  const append = (
    e: bigint,
    segment: bigint,
    bytes: Uint8Array | null,
    length: bigint,
  ) => {
    const result = new BigUint64Array(5).fill(0xffffffffffffffffn);
    assertEquals(
      lib.symbols.raop_stream_append(raw, e, segment, bytes, length, result),
      0,
    );
    return [...result];
  };
  try {
    assertEquals(append(0n, highSegment, pcm(1), 4n), [
      0n,
      highSegment,
      0n,
      3n,
      1n,
    ]);
    assertEquals(append(epoch, 0n, pcm(1), 4n), [epoch, 0n, 0n, 3n, 1n]);
    assertEquals(append(epoch, highSegment, pcm(1), 3n), [
      epoch,
      highSegment,
      0n,
      3n,
      1n,
    ]);
    assertEquals(append(epoch, highSegment, null, 4n), [
      epoch,
      highSegment,
      0n,
      3n,
      1n,
    ]);
    assertEquals(append(0xffffffffffffffffn, highSegment, pcm(1), 4n), [
      0xffffffffffffffffn,
      highSegment,
      0n,
      2n,
      0n,
    ]);
    assertEquals(append(epoch, highSegment, null, 0n), [
      epoch,
      highSegment,
      0n,
      0n,
      0n,
    ]);
    const competitor = createFfiStream();
    try {
      assertEquals(
        (await competitor.append({
          epoch: competitor.epoch,
          segment: 1n,
          pcm: pcm(1),
        })).status,
        'accepted',
        'refused and empty input must not claim the active-stream guard',
      );
    } finally {
      await competitor.close();
    }
    // Refusals above cannot use any of the bounded capacity or claim another
    // stream. Exactly the whole cap is still available, then zero is reported.
    assertEquals(append(epoch, highSegment, pcm(cap), BigInt(cap * 4)), [
      epoch,
      highSegment,
      BigInt(cap),
      0n,
      0n,
    ]);
    assertEquals(append(epoch, highSegment, pcm(1), 4n), [
      epoch,
      highSegment,
      0n,
      1n,
      0n,
    ]);
    await libraryProof();
  } finally {
    assertEquals(await lib.symbols.raop_stream_free(raw), 0);
  }
});

test('typed validation never truncates identities and mismatched epochs cannot reserve ingress', async () => {
  const stream = createFfiStream();
  try {
    const append = (epoch: bigint, segment: bigint, bytes = pcm(1)) =>
      stream.append({ epoch, segment, pcm: bytes });
    for (const invalid of [-1n, 1n << 64n]) {
      await assertRejects(
        () => append(invalid, 1n),
        RangeError,
        'unsigned 64-bit',
      );
      await assertRejects(
        () => append(stream.epoch, invalid),
        RangeError,
        'unsigned 64-bit',
      );
    }
    assertEquals((await append(stream.epoch, 0n)).status, 'error');
    assertEquals(
      (await append(stream.epoch, 1n, new Uint8Array(3))).status,
      'error',
    );
    assertEquals(
      (await append(stream.epoch + 1n, highSegment)).status,
      'canceled',
    );
    const exact = await append(stream.epoch, highSegment, pcm(cap));
    assertEquals([exact.acceptedFrames, exact.status], [
      BigInt(cap),
      'accepted',
    ]);
    await libraryProof();
  } finally {
    await stream.close();
  }
});

test('busy stream errors accept nothing and do not cross-feed the owner', async () => {
  const owner = createFfiStream(), other = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  let ready = false;
  const attachment = owner.attach((event, value) => {
    if (event === 'state' && value === 'connected') ready = true;
  });
  try {
    const expected = pcm(704);
    assertEquals(
      (await owner.append({ epoch: owner.epoch, segment: 1n, pcm: expected }))
        .acceptedFrames,
      704n,
    );
    const refused = await other.append({
      epoch: other.epoch,
      segment: highSegment,
      pcm: pcm(704, 400),
    });
    assertEquals(refused, {
      streamId: other.id,
      epoch: other.epoch,
      segment: highSegment,
      acceptedFrames: 0n,
      status: 'error',
      error: 'busy',
    });
    await attachment.start(profile(receiver), input);
    await until('owner ready', () => ready);
    await rendered(receiver, expected);
    await libraryProof();
  } finally {
    await Promise.all([owner.close(), other.close()]);
    receiver.close();
  }
});

test('submitted local reset returns not-ready without waiting or copying replacement', async () => {
  const stream = createFfiStream();
  const receiver = await startFakeRaop({
    captureAudio: true,
    captureWire: true,
  });
  let ready = false;
  const attachment = stream.attach((event, value) => {
    if (event === 'state' && value === 'connected') ready = true;
  });
  try {
    const reset = stream.reset();
    assertEquals(
      await stream.append({
        epoch: stream.epoch,
        segment: highSegment,
        pcm: pcm(352, 500),
      }),
      {
        streamId: stream.id,
        epoch: stream.epoch,
        segment: highSegment,
        acceptedFrames: 0n,
        status: 'not-ready',
      },
    );
    await reset;
    const expected = pcm(704);
    assertEquals(
      (await stream.append({
        epoch: stream.epoch,
        segment: highSegment,
        pcm: expected,
      })).status,
      'accepted',
    );
    await attachment.start(profile(receiver), input);
    await until('post-reset ready', () => ready);
    await rendered(receiver, expected);
    await libraryProof();
  } finally {
    await stream.close();
    receiver.close();
  }
});

test('close joins admitted receipts and stops further append admission', async () => {
  const stream = createFfiStream();
  const admitted = stream.append({
    epoch: stream.epoch,
    segment: highSegment,
    pcm: pcm(cap + 1),
  });
  const closing = stream.close();
  assertEquals(stream.close(), closing);
  const receipt = await admitted;
  assertEquals([receipt.acceptedFrames, receipt.status], [
    BigInt(cap),
    'backpressure',
  ]);
  await assertRejects(
    () => stream.append({ epoch: stream.epoch, segment: 1n, pcm: pcm(1) }),
    Error,
    'closed',
  );
  await libraryProof();
  await closing;
});

async function faultChild(mode: string) {
  const directory = await Deno.makeTempDir({ prefix: 'raop-admission-' });
  const interposer = `${directory}/faultinject.so`;
  const build = await new Deno.Command('cc', {
    args: [
      '-shared',
      '-fPIC',
      '-o',
      interposer,
      new URL('../helper/raop/test/faultinject.c', import.meta.url).pathname,
      '-ldl',
      '-pthread',
    ],
  }).output();
  assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      'test',
      '--frozen',
      '--cached-only',
      '--node-modules-dir=manual',
      '-A',
      '--filter',
      `RAOP admission: ${mode}`,
      new URL(import.meta.url).pathname,
    ],
    env: {
      LD_PRELOAD: interposer,
      RAOP_ADMISSION_CASE: mode,
      RAOP_ADMISSION_DIRECTORY: directory,
      RAOP_FI_APPEND_ARM_FILE: `${directory}/append.arm`,
      RAOP_FI_RESET_ARM_FILE: `${directory}/reset.arm`,
    },
  }).output();
  await Deno.writeFile(`${directory}/child.stdout`, result.stdout);
  await Deno.writeFile(`${directory}/child.stderr`, result.stderr);
  const stdout = new TextDecoder().decode(result.stdout);
  assertEquals(
    result.code,
    0,
    stdout + new TextDecoder().decode(result.stderr),
  );
  assert(/1 passed.*0 failed/.test(stdout));
  for (const line of stdout.split('\n')) {
    if (line.startsWith('admission native library:')) console.log(line);
  }
}

for (
  const mode of [
    'allocation failure is an error not backpressure',
    'native pending reset refuses input before the loop callback',
  ]
) {
  test(mode, async () => {
    if (Deno.env.get('RAOP_ADMISSION_CASE') !== mode) {
      return await faultChild(mode);
    }
    const directory = Deno.env.get('RAOP_ADMISSION_DIRECTORY')!;
    if (mode.startsWith('allocation')) {
      const stream = createFfiStream();
      const receiver = await startFakeRaop({
        captureAudio: true,
        captureWire: true,
      });
      let ready = false;
      const attachment = stream.attach((event, value) => {
        if (event === 'state' && value === 'connected') ready = true;
      });
      try {
        await Deno.writeTextFile(`${directory}/append.arm`, 'armed');
        const failed = await stream.append({
          epoch: stream.epoch,
          segment: highSegment,
          pcm: pcm(704, 500),
        });
        assertEquals(failed, {
          streamId: stream.id,
          epoch: stream.epoch,
          segment: highSegment,
          acceptedFrames: 0n,
          status: 'error',
          error: 'allocation',
        });
        assertEquals(
          await Deno.stat(`${directory}/append.arm`).then(
            () => true,
            () => false,
          ),
          false,
        );
        const expected = pcm(704);
        assertEquals(
          (await stream.append({
            epoch: stream.epoch,
            segment: highSegment,
            pcm: expected,
          })).acceptedFrames,
          704n,
        );
        await attachment.start(profile(receiver), input);
        await until('allocation recovery ready', () => ready);
        await rendered(receiver, expected);
        await libraryProof();
      } finally {
        await stream.close();
        receiver.close();
      }
    } else {
      const lib = raopFfiInternals.loadLibrary();
      const observer = Deno.dlopen(`${directory}/faultinject.so`, {
        raop_fi_once_blocking: { parameters: [], result: 'i32' },
      });
      const raw = lib.symbols.raop_stream_new();
      assert(raw);
      const epoch = lib.symbols.raop_stream_epoch(raw);
      const receiver = await startFakeRaop({
        captureAudio: true,
        captureWire: true,
      });
      let attachment: Deno.PointerValue = null;
      let resetting: Promise<number> | undefined;
      try {
        await Deno.writeTextFile(`${directory}/reset.arm`, 'armed');
        resetting = lib.symbols.raop_stream_reset(raw);
        await until(
          'native reset admission held before callback',
          () => observer.symbols.raop_fi_once_blocking() === 1,
        );
        const result = new BigUint64Array(5);
        assertEquals(
          lib.symbols.raop_stream_append(
            raw,
            epoch,
            highSegment,
            pcm(352, 500),
            352n * 4n,
            result,
          ),
          0,
        );
        assertEquals([...result], [epoch, highSegment, 0n, 4n, 0n]);
        await Deno.remove(`${directory}/reset.arm`);
        assertEquals(await resetting, 0);
        const expected = pcm(704);
        assertEquals(
          lib.symbols.raop_stream_append(
            raw,
            epoch,
            highSegment,
            expected,
            BigInt(expected.length),
            result,
          ),
          0,
        );
        assertEquals([...result], [epoch, highSegment, 704n, 0n, 0n]);
        attachment = lib.symbols.raop_stream_attach(raw);
        assert(attachment);
        const text = (value: string) => new TextEncoder().encode(value + '\0');
        assertEquals(
          lib.symbols.raop_start_v2(
            attachment,
            text('127.0.0.1'),
            receiver.port,
            text('Admission'),
            50,
            3,
            0,
            0,
            10000,
            0,
            0,
            0,
            text(''),
            text(''),
            0,
            null,
            0n,
            null,
            0n,
          ),
          0,
        );
        await rendered(receiver, expected);
        await libraryProof();
      } finally {
        await Deno.remove(`${directory}/reset.arm`).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
        await resetting;
        if (attachment) {
          assertEquals(await lib.symbols.raop_free(attachment), 0);
        }
        assertEquals(await lib.symbols.raop_stream_free(raw), 0);
        observer.close();
        receiver.close();
      }
    }
  });
}
