// Exact admission and ordered native cancellation. Production boot consumers are
// in airplay-stream-cancel.test.ts; local-reset cases remain local-only proofs.
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

function cancelTest(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `RAOP cancel: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

cancelTest(
  'mixed retirement captures one cutoff and never FLUSHes the retiring attachment',
  async () => {
    const gate = Promise.withResolvers<void>();
    const receivers = await Promise.all([
      startFakeRaop({ captureAudio: true, captureWire: true }),
      startFakeRaop({
        captureAudio: true,
        captureWire: true,
        beforeFlushReply: () => gate.promise,
      }),
    ]);
    const stream = createFfiStream();
    const attachments = receivers.map(() => stream.attach(() => {}));
    try {
      await Promise.all(
        attachments.map((a, i) => a.start(profile(receivers[i]), input)),
      );
      await stream.append({
        epoch: stream.epoch,
        segment: 1n,
        pcm: pcm(353, 900),
      });
      await until(
        'old packet at both',
        () => receivers.every((r) => r.sessions[0]?.audioPackets === 1),
      );
      const old = stream.epoch;
      const retiring = [attachments[0].id];
      const canceled = stream.cancel(old, retiring);
      retiring[0] = attachments[1].id; // native owns an immutable copied disposition
      assertEquals(stream.epoch, old + 1n);
      assertEquals(
        (await stream.append({
          epoch: stream.epoch,
          segment: 2n,
          pcm: pcm(352),
        })).status,
        'not-ready',
      );
      await until(
        'retirement and held survivor ACK',
        () =>
          receivers[0].sessions[0].closedAtMs !== null &&
          receivers[1].sessions[0].flushes === 1,
      );
      assertEquals(receivers[0].sessions[0].flushes, 0);
      assertEquals(receivers[0].sessions[0].teardowns, 1);
      assertEquals(
        (await stream.append({
          epoch: stream.epoch,
          segment: 2n,
          pcm: pcm(352),
        })).acceptedFrames,
        0n,
      );
      gate.resolve();
      const result = await canceled;
      assertEquals([result.status, result.cutoffFrames], ['ready', 0n]);
      const expected = pcm(352, 5000);
      await stream.append({
        epoch: stream.epoch,
        segment: 2n,
        pcm: expected.subarray(0, 351 * 4),
      });
      await stream.append({
        epoch: stream.epoch,
        segment: 3n,
        pcm: expected.subarray(351 * 4),
      });
      await postCancelRendered(receivers[1], expected);
      assertEquals(receivers[0].sessions[0].audioPackets, 1);
      await stream.ackCancel(old);
      await libraryProof();
    } finally {
      gate.resolve();
      await stream.close();
      receivers.forEach((r) => r.close());
    }
  },
);

cancelTest(
  'retirement identities reject foreign and duplicate attachments without advancing epoch',
  async () => {
    const stream = createFfiStream(), foreign = createFfiStream();
    try {
      const a = stream.attach(() => {}), b = foreign.attach(() => {});
      const epoch = stream.epoch;
      await assertRejects(() => stream.cancel(epoch, [b.id]), Error, 'refused');
      await assertRejects(
        () => stream.cancel(epoch, [a.id, a.id]),
        Error,
        'refused',
      );
      await assertRejects(
        () => stream.cancel(epoch, [-1n]),
        RangeError,
        'unsigned',
      );
      assertEquals(stream.epoch, epoch);
      const result = await stream.cancel(epoch, [a.id]);
      assertEquals(result.status, 'ready');
      await stream.ackCancel(epoch);
      await libraryProof();
    } finally {
      await stream.close();
      await foreign.close();
    }
  },
);

cancelTest(
  'retiring-only cancellation retains scheduled cutoff after destroying its old session',
  async () => {
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    const stream = createFfiStream();
    const attachment = stream.attach(() => {});
    try {
      await attachment.start(profile(receiver), input);
      await stream.append({
        epoch: stream.epoch,
        segment: 1n,
        pcm: pcm(704, 1600),
      });
      await rendered(receiver, pcm(704, 1600));
      const epoch = stream.epoch;
      const result = await stream.cancel(epoch, [attachment.id]);
      assertEquals([result.status, result.cutoffFrames], ['ready', 704n]);
      await until(
        'old session destroyed',
        () => receiver.sessions[0].closedAtMs !== null,
      );
      assertEquals([
        receiver.sessions[0].flushes,
        receiver.sessions[0].teardowns,
      ], [0, 1]);
      assertEquals(
        result.cutoffFrames,
        704n,
        'destruction does not erase the captured old schedule',
      );
      await stream.ackCancel(epoch);
      await libraryProof();
    } finally {
      await stream.close();
      receiver.close();
    }
  },
);

async function postCancelRendered(
  receiver: Receiver,
  expected: Uint8Array,
  oldFrames = 352,
) {
  const session = receiver.sessions[0];
  await until(
    'replacement packets',
    () => session.audioPackets === (oldFrames + expected.length / 4) / 352,
  );
  assertEquals(
    decodeReceiverAudio(
      session.sdp,
      session.audioPayloads.slice(oldFrames / 352),
    ),
    expected,
  );
  const pending = renderScheduledAudio(session, receiver.nowMs());
  assertEquals(pending.issues, []);
  assert(pending.lastPresentationAtMs !== null);
  await until(
    'replacement scheduled boundary',
    () =>
      receiver.nowMs() > pending.lastPresentationAtMs! +
          (pending.clockUncertaintyMs ?? 0),
  );
  const rendered = renderScheduledAudio(session, receiver.nowMs());
  assertEquals(rendered.issues, []);
  assertEquals(rendered.pcm, expected);
  assertEquals(rendered.pendingFrames, 0);
  assertEquals(
    rendered.discarded.map((range) => [range.reason, range.frames]),
    oldFrames ? [['flush', oldFrames]] : [],
  );
  assertEquals([session.flushes, session.teardowns, receiver.sessions.length], [
    1,
    0,
    1,
  ]);
}

cancelTest(
  '353/cancel/351 preserves every accepted replacement frame behind held FLUSH',
  async () => {
    const gate = Promise.withResolvers<void>();
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
      beforeFlushReply: () => gate.promise,
    });
    let ready = false;
    const attachment = stream.attach((event, value) => {
      if (event === 'state' && value === 'connected') ready = true;
    });
    const oldEpoch = stream.epoch;
    const append = (epoch: bigint, bytes: Uint8Array) =>
      stream.append({ epoch, segment: highSegment, pcm: bytes });
    try {
      await attachment.start(profile(receiver), input);
      await until('ready', () => ready);
      assertEquals(
        (await append(oldEpoch, pcm(353, 900))).acceptedFrames,
        353n,
      );
      await until(
        'old complete packet',
        () => receiver.sessions[0].audioPackets === 1,
      );
      const session = receiver.sessions[0];
      const oldSequence = session.rtpSequences[0];
      let settled = false;
      const canceled = stream.cancel(oldEpoch).then((result) => {
        settled = true;
        return result;
      });
      assertEquals(stream.epoch, oldEpoch + 1n, 'epoch advances at submission');
      assertEquals((await append(oldEpoch, pcm(1))).status, 'canceled');
      assertEquals((await append(stream.epoch, pcm(351))).status, 'not-ready');
      await until('held FLUSH request', () => session.flushes === 1);
      await assertRejects(() => stream.ackCancel(oldEpoch), Error, 'pending');
      await assertRejects(
        () => attachment.transport.send({ cmd: 'flush' }),
        Error,
        'failed',
      );
      receiver.requestRetransmit(session.id, oldSequence);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assertEquals([settled, session.audioPackets], [false, 1]);
      assertEquals((await append(stream.epoch, pcm(351))).acceptedFrames, 0n);
      gate.resolve();
      const result = await canceled;
      assertEquals([
        result.status,
        result.cutoffFrames,
        result.epoch,
        result.nextEpoch,
      ], ['ready', 0n, oldEpoch, oldEpoch + 1n]);
      assert(result.admittedNs > 0n);
      const expected = pcm(352, 3000);
      assertEquals(
        (await append(stream.epoch, expected.subarray(0, 351 * 4)))
          .acceptedFrames,
        351n,
      );
      // b04 owns tail padding: this is one explicit real packet-completing frame,
      // asserted byte-for-byte, not implicit silence or a claimed 351-frame tail.
      assertEquals(
        (await append(stream.epoch, expected.subarray(351 * 4))).acceptedFrames,
        1n,
      );
      await postCancelRendered(receiver, expected);
      const count = session.audioPackets;
      receiver.requestRetransmit(session.id, oldSequence);
      await new Promise((resolve) => setTimeout(resolve, 60));
      assertEquals(
        session.audioPackets,
        count,
        'old cache stays revoked after readiness',
      );
      await stream.ackCancel(oldEpoch);
      await assertRejects(() => stream.ackCancel(oldEpoch), Error, 'absent');
      await libraryProof();
    } finally {
      gate.resolve();
      await stream.close();
      receiver.close();
    }
  },
);

cancelTest(
  'all attachment ACKs fence replacement and repeated cancellation supersedes only old work',
  async () => {
    const gates = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const receivers = await Promise.all(gates.map((gate) =>
      startFakeRaop({
        captureAudio: true,
        captureWire: true,
        beforeFlushReply: () => gate.promise,
      })
    ));
    const stream = createFfiStream();
    const attachments = receivers.map(() => stream.attach(() => {}));
    try {
      await Promise.all(
        attachments.map((attachment, i) =>
          attachment.start(profile(receivers[i]), input)
        ),
      );
      assertEquals(
        (await stream.append({
          epoch: stream.epoch,
          segment: 1n,
          pcm: pcm(353, 900),
        })).acceptedFrames,
        353n,
      );
      await until(
        'both old packets',
        () => receivers.every((r) => r.sessions[0]?.audioPackets === 1),
      );
      const firstEpoch = stream.epoch;
      const first = stream.cancel(firstEpoch);
      await until(
        'both held FLUSHes',
        () => receivers.every((r) => r.sessions[0].flushes === 1),
      );
      const secondEpoch = stream.epoch;
      const second = stream.cancel(secondEpoch);
      assertEquals((await first).status, 'canceled');
      gates[0].resolve();
      await new Promise((resolve) => setTimeout(resolve, 60));
      assertEquals(
        (await stream.append({
          epoch: stream.epoch,
          segment: 2n,
          pcm: pcm(704),
        })).status,
        'not-ready',
      );
      gates[1].resolve();
      assertEquals((await second).status, 'ready');
      const expected = pcm(704, 5000);
      assertEquals(
        (await stream.append({
          epoch: stream.epoch,
          segment: 2n,
          pcm: expected,
        })).acceptedFrames,
        704n,
      );
      await Promise.all(receivers.map((r) => postCancelRendered(r, expected)));
      await stream.ackCancel(firstEpoch);
      await stream.ackCancel(secondEpoch);
      await libraryProof();
    } finally {
      gates.forEach((gate) => gate.resolve());
      await stream.close();
      receivers.forEach((r) => r.close());
    }
  },
);

cancelTest(
  'blocked writer settles promptly and its accepted backlog never reaches replacement',
  async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    try {
      await stream.append({
        epoch: stream.epoch,
        segment: 1n,
        pcm: pcm(cap, 900),
      });
      const writing = stream.pcm(pcm(352, 1900));
      const rejected = assertRejects(() => writing, Error, 'canceled');
      const before = performance.now();
      const result = await stream.cancel(stream.epoch);
      await rejected;
      assert(
        performance.now() - before < 1000,
        'must not wait for two-second backlog drain',
      );
      assertEquals([result.status, result.cutoffFrames], ['ready', 0n]);
      const expected = pcm(704);
      assertEquals(
        (await stream.append({
          epoch: stream.epoch,
          segment: 2n,
          pcm: expected,
        })).acceptedFrames,
        704n,
      );
      await stream.attach(() => {}).start(profile(receiver), input);
      await rendered(receiver, expected);
      await stream.ackCancel(result.epoch);
      await libraryProof();
    } finally {
      await stream.close();
      receiver.close();
    }
  },
);

cancelTest(
  'close settles a held cancellation and joins session destruction without its ACK',
  async () => {
    const gate = Promise.withResolvers<void>();
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
      beforeFlushReply: () => gate.promise,
    });
    try {
      await stream.attach(() => {}).start(profile(receiver), input);
      await stream.append({ epoch: stream.epoch, segment: 1n, pcm: pcm(353) });
      await until('old packet', () => receiver.sessions[0]?.audioPackets === 1);
      const cancel = stream.cancel(stream.epoch);
      await until('held cancel', () => receiver.sessions[0].flushes === 1);
      const closing = stream.close();
      assertEquals(stream.close(), closing);
      assertEquals((await cancel).status, 'canceled');
      await closing;
      await until(
        'old socket destroyed',
        () => receiver.sessions[0].closedAtMs !== null,
      );
      await assertRejects(() => stream.cancel(stream.epoch), Error, 'closed');
      await libraryProof();
    } finally {
      gate.resolve();
      await stream.close();
      receiver.close();
    }
  },
);

cancelTest(
  'late old handshake is destroyed and cannot rearm the replacement epoch',
  async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      recordDelayMs: 180,
      captureAudio: true,
      captureWire: true,
    });
    let connected = 0;
    const attachment = stream.attach((event, value) => {
      if (event === 'state' && value === 'connected') connected++;
    });
    try {
      await attachment.start(profile(receiver), input);
      await until(
        'old RECORD held',
        () =>
          receiver.sessions[0]?.requests.some((r) => r.method === 'RECORD') ??
            false,
      );
      const result = await stream.cancel(stream.epoch);
      assertEquals([result.status, result.cutoffFrames], ['ready', 0n]);
      const expected = pcm(704, 7000);
      await stream.append({ epoch: stream.epoch, segment: 2n, pcm: expected });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assertEquals([connected, receiver.sessions[0].audioPackets], [0, 0]);
      assert(receiver.sessions[0].closedAtMs !== null);
      await attachment.start(profile(receiver), input);
      await until(
        'replacement session packets',
        () => receiver.sessions[1]?.audioPackets === 2,
      );
      // The old session has no PCM. The new independently scheduled consumer gets
      // all replacement bytes, despite the old delayed response.
      const session = receiver.sessions[1];
      const pending = renderScheduledAudio(session, receiver.nowMs());
      assertEquals(pending.issues, []);
      await until(
        'new session scheduled end',
        () =>
          receiver.nowMs() >
            pending.lastPresentationAtMs! + (pending.clockUncertaintyMs ?? 0),
      );
      assertEquals(
        renderScheduledAudio(session, receiver.nowMs()).pcm,
        expected,
      );
      assertEquals(connected, 1);
      await stream.ackCancel(result.epoch);
      await libraryProof();
    } finally {
      await stream.close();
      receiver.close();
    }
  },
);

cancelTest(
  'failed FLUSH proves readiness only through destruction before a fresh session',
  async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      refuseFlush: true,
      captureAudio: true,
      captureWire: true,
    });
    const attachment = stream.attach(() => {});
    try {
      await attachment.start(profile(receiver), input);
      await stream.append({ epoch: stream.epoch, segment: 1n, pcm: pcm(353) });
      await until('old packet', () => receiver.sessions[0]?.audioPackets === 1);
      const result = await stream.cancel(stream.epoch);
      assertEquals(result.status, 'ready');
      await until(
        'failed FLUSH session destroyed',
        () => receiver.sessions[0].closedAtMs !== null,
      );
      const expected = pcm(704, 8000);
      await stream.append({ epoch: stream.epoch, segment: 2n, pcm: expected });
      await attachment.start(profile(receiver), input);
      await until(
        'fresh packets',
        () => receiver.sessions[1]?.audioPackets === 2,
      );
      const session = receiver.sessions[1];
      assertEquals(
        decodeReceiverAudio(session.sdp, session.audioPayloads),
        expected,
      );
      const pending = renderScheduledAudio(session, receiver.nowMs());
      assertEquals(pending.issues, []);
      await until(
        'fresh scheduled end',
        () =>
          receiver.nowMs() >
            pending.lastPresentationAtMs! + (pending.clockUncertaintyMs ?? 0),
      );
      assertEquals(
        renderScheduledAudio(session, receiver.nowMs()).pcm,
        expected,
      );
      await stream.ackCancel(result.epoch);
      await libraryProof();
    } finally {
      await stream.close();
      receiver.close();
    }
  },
);

cancelTest(
  'native results survive more than sixteen cancels until individually acknowledged',
  async () => {
    const lib = raopFfiInternals.loadLibrary();
    const raw = lib.symbols.raop_stream_new();
    assert(raw);
    try {
      const receipt = new BigUint64Array(6);
      const epochs: bigint[] = [];
      assertEquals(lib.symbols.raop_stream_cancel(raw, 0n), -1);
      assertEquals(
        lib.symbols.raop_stream_cancel(raw, 0xffffffffffffffffn),
        -1,
      );
      for (let i = 0; i < 24; i++) {
        const epoch = lib.symbols.raop_stream_epoch(raw);
        epochs.push(epoch);
        assertEquals(lib.symbols.raop_stream_cancel(raw, epoch), 0);
        assertEquals(
          lib.symbols.raop_stream_cancel(raw, epoch),
          -1,
          'stale cancel never advances epoch twice',
        );
      }
      await until(
        'all retained cancels applied',
        () =>
          epochs.every((epoch) =>
            lib.symbols.raop_stream_cancel_poll(raw, epoch, receipt) === 1 &&
            receipt[2] !== 0n
          ),
      );
      for (const epoch of epochs) {
        assertEquals(
          lib.symbols.raop_stream_cancel_poll(raw, epoch, receipt),
          1,
        );
        const original = [...receipt];
        assertEquals(original.slice(0, 2), [epoch, epoch + 1n]);
        assert([1n, 2n].includes(receipt[2]));
        assertEquals([receipt[3], receipt[5]], [0n, 1n]);
        assertEquals(
          lib.symbols.raop_stream_cancel_poll(raw, epoch, receipt),
          1,
        );
        assertEquals([...receipt], original, 'poll does not consume');
        assertEquals(lib.symbols.raop_stream_cancel_ack(raw, epoch), 0);
        assertEquals(
          lib.symbols.raop_stream_cancel_poll(raw, epoch, receipt),
          0,
        );
      }
      await libraryProof();
    } finally {
      assertEquals(await lib.symbols.raop_stream_free(raw), 0);
    }
  },
);

cancelTest(
  'cutoff uses scheduled submitted frames rather than accepted backlog',
  async () => {
    const stream = createFfiStream();
    const receiver = await startFakeRaop({
      captureAudio: true,
      captureWire: true,
    });
    try {
      const attachment = stream.attach(() => {});
      await attachment.start(profile(receiver), input);
      const old = pcm(704);
      await stream.append({ epoch: stream.epoch, segment: 1n, pcm: old });
      await rendered(receiver, old);
      // These accepted frames have not reached a presentation boundary at cancel.
      const accepted = await stream.append({
        epoch: stream.epoch,
        segment: 2n,
        pcm: pcm(cap, 900),
      });
      assertEquals(accepted.acceptedFrames, BigInt(cap));
      const result = await stream.cancel(stream.epoch);
      assertEquals([result.status, result.cutoffFrames], ['ready', 704n]);
      await stream.ackCancel(result.epoch);
      const next = pcm(250 * 352, 1000);
      await stream.append({ epoch: stream.epoch, segment: 3n, pcm: next });
      const session = receiver.sessions[0];
      await until('all new packets', () => session.audioPackets === 252);
      const schedule = renderScheduledAudio(session, receiver.nowMs());
      assertEquals(schedule.issues, []);
      assert(schedule.lastPresentationAtMs !== null);
      const firstNewAt = schedule.lastPresentationAtMs -
        next.length / 4 * 1000 / 44100;
      await until(
        'partly presented new epoch',
        () => receiver.nowMs() > firstNewAt + 100,
      );
      const partial = await stream.cancel(stream.epoch);
      assert(
        partial.cutoffFrames !== null && partial.cutoffFrames > 0n &&
          partial.cutoffFrames < BigInt(next.length / 4),
      );
      // Map native admission time through the independent receiver timing exchange,
      // not performance.now or the sender's own presentation implementation.
      const reply = session.wire.find((event) => event.kind === 'timing-reply');
      const request = session.wire.find((event) =>
        event.kind === 'timing-request'
      );
      assert(reply && 'data' in reply && request && 'data' in request);
      const ns = (offset: number) => {
        const view = new DataView(reply.data.buffer, reply.data.byteOffset);
        return (BigInt(view.getUint32(offset)) - 2208988800n) * 1000000000n +
          BigInt(view.getUint32(offset + 4)) * 1000000000n / (1n << 32n);
      };
      const localAdmission = (request.atMs + reply.atMs) / 2 +
        Number(partial.admittedNs - (ns(16) + ns(24)) / 2n) / 1e6;
      const independent = renderScheduledAudio(session, localAdmission);
      assertEquals(independent.issues, []);
      const observedFrames = independent.pcm.length / 4 - 704;
      const tolerance =
        Math.ceil((independent.clockUncertaintyMs ?? 0) * 44.1) + 1;
      assert(
        Math.abs(Number(partial.cutoffFrames) - observedFrames) <= tolerance,
        `native cutoff ${partial.cutoffFrames}, independent ${observedFrames}, timing tolerance ${tolerance}`,
      );
      await stream.ackCancel(partial.epoch);
      await libraryProof();
    } finally {
      await stream.close();
      receiver.close();
    }
  },
);

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
