// b05a foundation: the real lazy device owner -> shipping native timeline ->
// independent scheduled UDP/ALAC consumer. HTTP/core adoption follows in b05b/c.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { createPlaybackTimeline } from '../src/playback-timeline.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createFfiStream, raopFfiInternals } from '../src/boots/raop-ffi.ts';
import type {
  AirplayCompletionKey,
  AirplayTimelineStream,
  AirplayTransport,
} from '../src/boots/airplay-profile.ts';
import { createOutputs } from '../src/player.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';

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
function pcm(frames: number, seed = 1) {
  const bytes = new Uint8Array(frames * 4), view = new DataView(bytes.buffer);
  for (let i = 0; i < frames; i++) {
    view.setInt16(i * 4, 500 + (i * 17 + seed) % 11000, true);
    view.setInt16(i * 4 + 2, -600 - (i * 19 + seed) % 12000, true);
  }
  return bytes;
}
function test(name: string, fn: () => Promise<void> | void) {
  Deno.test({
    name: `playback native position: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
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
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await Deno.readFile(path)),
  );
  console.log(
    `position native library: ${path} sha256=${
      Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('')
    }`,
  );
}
async function fixture(
  options: Parameters<typeof startFakeRaop>[0] = {},
  peers = 1,
) {
  const receivers = await Promise.all(
    Array.from(
      { length: peers },
      () =>
        startFakeRaop({ captureAudio: true, captureWire: true, ...options }),
    ),
  );
  const outputs = createOutputs();
  for (const [i, receiver] of receivers.entries()) {
    outputs.register({
      id: String(i + 1),
      name: `Position ${i + 1}`,
      type: 'AirPlay',
      host: '127.0.0.1',
      port: receiver.port,
      selected: true,
      volume: 50,
    });
  }
  let native: AirplayTimelineStream | undefined;
  let allocations = 0;
  const devices = createAirplayDevices({
    outputs,
    stream() {
      allocations++;
      return native = createFfiStream();
    },
    resolver: {
      resolve(_host, port) {
        const i = receivers.findIndex((r) => r.port === port);
        return Promise.resolve({
          name: `00112233440${i}@Position._raop._tcp.local`,
          host: 'fixture.local',
          address: '127.0.0.1',
          port: port!,
          ttlMs: 60000,
          txt: { tp: 'UDP', am: 'AppleTV2,1' },
        });
      },
      close() {},
    },
  });
  const stream = devices.createStream();
  const activate = async (i = 0, expectConnected = true) => {
    const prepared = await devices.protocol.prepare({
      id: String(i + 1),
      stream,
      targetRevision: devices.admission.describe(String(i + 1)).targetRevision,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    assert(prepared.ok, prepared.ok ? '' : prepared.error.message);
    let state = '';
    const result = await devices.protocol.activate(prepared.value, {
      volume: 50,
      positionMs: 0,
      lengthMs: 10000,
      title: '',
      artist: '',
    }, {
      publish() {},
      onEvent(event) {
        if (event.event === 'state') state = event.value ?? '';
      },
    });
    assert(result.ok, result.ok ? '' : result.error.message);
    await until(
      'native attachment outcome',
      () => expectConnected ? state === 'connected' : state === 'failed',
    );
    return result.value;
  };
  return {
    stream,
    devices,
    receivers,
    activate,
    get native() {
      assert(native);
      return native;
    },
    get allocations() {
      return allocations;
    },
    async close() {
      await stream.close();
      devices.close();
      receivers.forEach((r) => r.close());
    },
  };
}
function identity(
  epoch: bigint,
  source: bigint,
  target: bigint,
): AirplayCompletionKey {
  return { epoch, source, target, revision: 1n };
}
const origin = {
  streamId: 2n,
  epoch: 1n,
  entryId: 10,
  generation: 4,
  originMs: 5000,
};

test('core source identities hold the origin and only project matching scheduled facts', () => {
  const timeline = createPlaybackTimeline();
  const a = timeline.begin(origin);
  assertEquals(timeline.position(a)!.positionMs, 5000);
  assertEquals(timeline.position(a)!.capturedNs, null);
  const fact = {
    ...a,
    capturedNs: 100n,
    sourceFrames: 441n,
    status: 'scheduled' as const,
    error: 'none',
  };
  for (const bad of [{ streamId: 3n }, { epoch: 2n }, { source: 99n }]) {
    assertEquals(timeline.observe(a, { ...fact, ...bad }), false);
  }
  assertEquals(
    timeline.observe({ ...a }, fact),
    false,
    'copied token has no source authority',
  );
  assert(timeline.observe(a, fact));
  assertEquals(timeline.position(a)!.positionMs, 5010);
  assertEquals(
    timeline.observe(a, { ...fact, capturedNs: 99n, sourceFrames: 882n }),
    false,
  );
  assert(timeline.observe(a, { ...fact, capturedNs: 200n }));
  assertEquals(
    timeline.position(a)!.positionMs,
    5010,
    'later starvation observation cannot invent elapsed media',
  );
  assert(Object.isFrozen(a) && Object.isFrozen(timeline.position(a)));
});

test('core commits the atomic old cutoff and rejects delayed old facts after repeat or seek', () => {
  const timeline = createPlaybackTimeline(), a = timeline.begin(origin);
  const fact = {
    ...a,
    capturedNs: 100n,
    sourceFrames: 441n,
    status: 'scheduled' as const,
    error: 'none',
  };
  const cutoff = {
    ...a,
    nextEpoch: 2n,
    admittedNs: 110n,
    progress: { ...fact, capturedNs: 110n, sourceFrames: 882n },
  };
  assertEquals(timeline.cancel(a, { ...cutoff, progress: null }), false);
  assertEquals(timeline.cancel(a, { ...cutoff, epoch: 9n }), false);
  assertEquals(timeline.cancel(a, { ...cutoff, admittedNs: 111n }), false);
  assert(timeline.cancel(a, cutoff));
  assertEquals(timeline.position(a)!.positionMs, 5020);
  assert(timeline.position(a)!.canceled);
  assertEquals(
    timeline.observe(a, { ...fact, capturedNs: 999n, sourceFrames: 999n }),
    false,
  );
  assertThrows(() => timeline.begin(origin), RangeError);
  const repeated = timeline.begin({ ...origin, epoch: 2n });
  assert(repeated.source !== a.source);
  assertEquals(timeline.observe(repeated, fact), false);
  assertEquals(timeline.cancel(repeated, cutoff), false);
  assertEquals(timeline.position(repeated)!.positionMs, 5000);
});

test('core retires mappings without reusing source identities and rejects unrepresentable positions', () => {
  const timeline = createPlaybackTimeline(), a = timeline.begin(origin);
  timeline.retire(a);
  assertEquals(timeline.position(a), null);
  const b = timeline.begin(origin);
  assert(b.source > a.source);
  const fact = {
    ...b,
    capturedNs: 10n,
    sourceFrames: -1n,
    status: 'scheduled' as const,
    error: 'none',
  };
  assertThrows(() => timeline.observe(b, fact), RangeError);
  assertThrows(
    () => timeline.observe(b, { ...fact, sourceFrames: 0xffffffffffffffffn }),
    RangeError,
  );
  assertThrows(
    () => timeline.begin({ ...origin, originMs: Number.MAX_SAFE_INTEGER + 1 }),
    RangeError,
  );
  timeline.close();
  assertEquals(timeline.position(b), null);
  assertThrows(() => timeline.begin(origin), Error, 'closed');
});

test('lazy bridge renders adjacent sealed sources and retains completion until exact ack', async () => {
  const f = await fixture();
  const a = pcm(353), b = pcm(351, 900), expected = new Uint8Array(704 * 4);
  expected.set(a);
  expected.set(b, a.length);
  try {
    assertEquals([f.stream.id, f.stream.epoch, f.allocations], [null, null, 0]);
    const attachment = await f.activate();
    const epoch = f.stream.epoch!;
    assertEquals(f.allocations, 1);
    assertEquals(
      (await f.stream.appendSource({ epoch, source: 1n, segment: 1n, pcm: a }))
        .acceptedFrames,
      353n,
    );
    const first = await f.stream.seal(epoch, 1n, 353n);
    assertEquals([first.status, first.inputEnd], ['accepted', 353n]);
    assertEquals(
      (await f.stream.appendSource({ epoch, source: 2n, segment: 2n, pcm: b }))
        .sourceOffset,
      0n,
    );
    assertEquals((await f.stream.seal(epoch, 2n, 351n)).inputEnd, 704n);
    assertEquals((await f.stream.endStream(epoch, 704n)).status, 'accepted');
    assertEquals(
      (await f.stream.pollCompletion(identity(epoch, 2n, 351n)))!.status,
      'pending',
    );
    await assertRejects(
      () => f.stream.ackCompletion(identity(epoch, 2n, 351n)),
      Error,
      'pending',
    );
    for (const key of [identity(epoch, 1n, 353n), identity(epoch, 2n, 351n)]) {
      const completion = await f.stream.waitCompletion(key);
      assertEquals([completion.status, completion.attachments[0].outcome], [
        'complete',
        'complete',
      ]);
      await until(
        'independent receiver renders complete source',
        () =>
          renderScheduledAudio(
            f.receivers[0].sessions[0],
            f.receivers[0].nowMs(),
          ).pcm.length >= expected.length,
      );
      const replay = renderScheduledAudio(
        f.receivers[0].sessions[0],
        f.receivers[0].nowMs(),
      );
      assertEquals(replay.issues, []);
      assertEquals(replay.pcm.subarray(0, expected.length), expected);
      assertEquals(
        replay.pcm.subarray(expected.length),
        new Uint8Array(replay.pcm.length - expected.length),
      );
      assertEquals(
        (await f.stream.progress(epoch, key.source))!.sourceFrames,
        key.target,
      );
      assertEquals(
        (await f.stream.source(epoch, key.source))!.target,
        key.target,
      );
      assertEquals(await f.stream.pollCompletion(key), completion);
      await f.stream.ackCompletion(key);
      assertEquals(await f.stream.pollCompletion(key), null);
      assertEquals(await f.stream.source(epoch, key.source), null);
    }
    assertEquals(await f.stream.range(epoch, 0n), null);
    assertEquals([
      f.receivers[0].sessions.length,
      f.receivers[0].sessions[0].flushes,
    ], [1, 0]);
    await assertRejects(() => attachment.pcm(pcm(1)), Error, 'belongs');
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('atomic source cutoff excludes underrun and survives held FLUSH plus replacement', async () => {
  const flush = Promise.withResolvers<void>(),
    f = await fixture({ beforeFlushReply: () => flush.promise });
  const timeline = createPlaybackTimeline();
  try {
    await f.activate();
    const a = timeline.begin({
      ...origin,
      streamId: f.stream.id!,
      epoch: f.stream.epoch!,
    });
    const bytes = pcm(353);
    await f.stream.appendSource({ ...a, segment: 1n, pcm: bytes });
    await until('source scheduled plus real underrun', async () => {
      const p = await f.stream.progress(a.epoch, a.source);
      return !!p && p.sourceFrames === 353n && p.silenceFrames > 4410n;
    });
    const old = (await f.stream.progress(a.epoch, a.source))!;
    assert(timeline.observe(a, old));
    const pending = f.stream.cancelSource(a.epoch, a.source);
    assertEquals(
      f.stream.epoch,
      a.epoch + 1n,
      'cancellation fences before first await',
    );
    let settled = false;
    void pending.then(() => settled = true);
    await until(
      'held native FLUSH',
      () => f.receivers[0].sessions[0].flushes === 1,
    );
    await sleep(100);
    assertEquals(settled, false);
    assertEquals(
      (await f.stream.appendSource({
        epoch: f.stream.epoch!,
        source: 99n,
        segment: 2n,
        pcm: pcm(351),
      })).status,
      'not-ready',
    );
    assertEquals(await f.stream.progress(a.epoch, a.source), null);
    assertEquals(await f.stream.source(a.epoch, a.source), null);
    flush.resolve();
    const cutoff = await pending;
    assert(cutoff.progress);
    assertEquals([
      cutoff.source,
      cutoff.progress.sourceFrames,
      cutoff.progress.capturedNs,
    ], [a.source, 353n, cutoff.admittedNs]);
    assert(cutoff.cutoffFrames! > cutoff.progress.sourceFrames);
    assert(cutoff.progress.silenceFrames > 4410n);
    assert(timeline.cancel(a, cutoff));
    assertEquals(timeline.position(a)!.positionMs, 5008);
    const frozen = timeline.position(a);
    assertEquals(timeline.observe(a, old), false);
    assertEquals(timeline.position(a), frozen);
    const renderedOld = renderScheduledAudio(
      f.receivers[0].sessions[0],
      f.receivers[0].nowMs(),
    );
    assertEquals(renderedOld.issues, []);
    assertEquals(renderedOld.pcm.subarray(0, bytes.length), bytes);
    assertEquals(
      renderedOld.pcm.subarray(bytes.length),
      new Uint8Array(renderedOld.pcm.length - bytes.length),
    );
    const b = timeline.begin({
      ...origin,
      streamId: a.streamId,
      epoch: f.stream.epoch!,
      originMs: frozen!.positionMs,
    });
    const replacement = pcm(351, 9000);
    await f.stream.appendSource({ ...b, segment: 2n, pcm: replacement });
    await f.stream.seal(b.epoch, b.source, 351n);
    await f.stream.endStream(b.epoch, 351n);
    assertEquals(
      (await f.stream.waitCompletion(identity(b.epoch, b.source, 351n))).status,
      'complete',
    );
    await until(
      'independent replacement renders',
      () =>
        renderScheduledAudio(f.receivers[0].sessions[0], f.receivers[0].nowMs())
          .ranges.some((r) => r.epoch === Number(b.epoch)),
    );
    const replay = renderScheduledAudio(
      f.receivers[0].sessions[0],
      f.receivers[0].nowMs(),
    );
    const replacementRanges = replay.ranges.filter((r) =>
      r.epoch === Number(b.epoch)
    );
    const actual = new Uint8Array(
      replacementRanges.reduce((n, r) => n + r.pcm.length, 0),
    );
    let offset = 0;
    for (const r of replacementRanges) {
      actual.set(r.pcm, offset);
      offset += r.pcm.length;
    }
    assertEquals(actual.subarray(0, replacement.length), replacement);
    assertEquals(
      actual.subarray(replacement.length),
      new Uint8Array(actual.length - replacement.length),
    );
    assertEquals(replay.issues, []);
    await f.stream.ackCancel(a.epoch);
    await f.stream.ackCompletion(identity(b.epoch, b.source, 351n));
    await libraryProof();
  } finally {
    flush.resolve();
    await f.close();
    timeline.close();
  }
});

test('mid-source cutoff matches the independent schedule at cancel admission not delayed readiness', async () => {
  const flush = Promise.withResolvers<void>(),
    f = await fixture({ beforeFlushReply: () => flush.promise });
  const bytes = pcm(44100);
  try {
    await f.activate();
    const epoch = f.stream.epoch!;
    await f.stream.appendSource({ epoch, source: 7n, segment: 1n, pcm: bytes });
    await until(
      'mid-source scheduled watermark',
      async () => (await f.stream.progress(epoch, 7n))!.sourceFrames > 4410n,
    );
    const receiver = f.receivers[0], before = receiver.nowMs();
    const pending = f.stream.cancelSource(epoch, 7n);
    const after = receiver.nowMs();
    await until('held FLUSH', () => receiver.sessions[0].flushes === 1);
    await sleep(300);
    flush.resolve();
    const cutoff = await pending;
    assert(cutoff.progress && cutoff.progress.sourceFrames < 44100n);
    const replay = renderScheduledAudio(receiver.sessions[0], after);
    assert(replay.clockUncertaintyMs !== null);
    const low = renderScheduledAudio(
      receiver.sessions[0],
      Math.max(0, before - replay.clockUncertaintyMs),
    ).pcm.length / 4;
    const high = renderScheduledAudio(
      receiver.sessions[0],
      after + replay.clockUncertaintyMs,
    ).pcm.length / 4;
    assert(
      Number(cutoff.progress.sourceFrames) >= low &&
        Number(cutoff.progress.sourceFrames) <= high,
      `atomic source cutoff ${cutoff.progress.sourceFrames} lies in independent schedule ${low}..${high}`,
    );
    assertEquals(replay.pcm, bytes.subarray(0, replay.pcm.length));
    await f.stream.ackCancel(epoch);
    await libraryProof();
  } finally {
    flush.resolve();
    await f.close();
  }
});

async function cohortPacerChild() {
  const directory = await Deno.makeTempDir({ prefix: 'playback-cohort-' });
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
      '--filter=lazy completion cohort revision',
      new URL(import.meta.url).pathname,
    ],
    env: {
      LD_PRELOAD: interposer,
      MELOFON_COHORT_CASE: 'held-pacer',
      RAOP_PROGRESS_HOLD: `${directory}/hold`,
    },
  }).output();
  await Deno.writeFile(`${directory}/child.stdout`, child.stdout);
  await Deno.writeFile(`${directory}/child.stderr`, child.stderr);
  const stdout = new TextDecoder().decode(child.stdout);
  assertEquals(child.code, 0, stdout + new TextDecoder().decode(child.stderr));
  assert(/1 passed.*0 failed/.test(stdout));
  for (const line of stdout.split('\n')) {
    if (line.startsWith('position native library:')) console.log(line);
  }
}

test('lazy completion cohort revision reports withdrawal and only credits the healthy peer', async () => {
  if (Deno.env.get('MELOFON_COHORT_CASE') !== 'held-pacer') {
    return await cohortPacerChild();
  }
  const hold = Deno.env.get('RAOP_PROGRESS_HOLD')!;
  await Deno.writeTextFile(hold, 'hold actual emission before withdrawal');
  const f = await fixture({}, 2), bytes = pcm(44100);
  try {
    const peers = await Promise.all([f.activate(0), f.activate(1)]);
    const epoch = f.stream.epoch!, key = identity(epoch, 1n, 44100n);
    assertEquals(
      (await f.stream.appendSource({
        epoch,
        source: 1n,
        segment: 1n,
        pcm: bytes,
      })).acceptedFrames,
      44100n,
    );
    await f.stream.seal(epoch, 1n, 44100n);
    await f.stream.endStream(epoch, 44100n);
    assertEquals((await f.stream.source(epoch, 1n))!.fedFrames, 0n);
    await peers[0].close();
    const old = await f.stream.waitCompletion(key);
    assertEquals(old.status, 'failed');
    const withdrawn = old.attachments.find((a) => a.outcome === 'withdrawn');
    assert(withdrawn);
    await Deno.remove(hold);
    // Do not revise while emission is held. Let the loop see the old failed
    // receipt with no pending replacement, and keep its healthy queued tail.
    await until(
      'healthy prefix schedules before core observes the failed cohort',
      async () => (await f.stream.progress(epoch, 1n))!.sourceFrames > 0n,
    );
    const revision = await f.stream.reviseCompletion(key, [
      withdrawn.attachment,
    ]);
    await until(
      'revised cohort reaches a terminal native outcome',
      async () =>
        (await f.stream.pollCompletion(revision))!.status !== 'pending',
    );
    const result = await f.stream.waitCompletion(revision);
    assertEquals(result.status, 'complete');
    assertEquals(result.required, 1n);
    assert(
      result.attachments.some((a) => a.excluded && a.outcome === 'withdrawn'),
    );
    await until(
      'healthy receiver renders',
      () =>
        renderScheduledAudio(f.receivers[1].sessions[0], f.receivers[1].nowMs())
          .pcm.length >= bytes.length,
    );
    const replay = renderScheduledAudio(
      f.receivers[1].sessions[0],
      f.receivers[1].nowMs(),
    );
    assertEquals(replay.issues, []);
    assertEquals(replay.pcm.subarray(0, bytes.length), bytes);
    assertEquals(
      replay.pcm.subarray(bytes.length),
      new Uint8Array(replay.pcm.length - bytes.length),
    );
    assertEquals(await f.stream.pollCompletion(key), old);
    await f.stream.ackCompletion(key);
    await f.stream.ackCompletion(revision);
    await libraryProof();
  } finally {
    await Deno.remove(hold).catch(() => {});
    await f.close();
  }
});

test('close joins lazy completion waits and source cancellation with a held FLUSH', async () => {
  const flush = Promise.withResolvers<void>(),
    f = await fixture({ beforeFlushReply: () => flush.promise });
  try {
    await f.activate();
    const epoch = f.stream.epoch!;
    await f.stream.appendSource({
      epoch,
      source: 1n,
      segment: 1n,
      pcm: pcm(704),
    });
    await f.stream.seal(epoch, 1n, 704n);
    const waiting = f.stream.waitCompletion(identity(epoch, 1n, 704n));
    const progress = f.stream.progress(epoch, 1n);
    const cancellation = f.stream.cancelSource(epoch, 1n);
    await until('held FLUSH', () => f.receivers[0].sessions[0].flushes === 1);
    const closing = f.stream.close();
    assertEquals(f.stream.close(), closing);
    const result = await waiting;
    assertEquals(result.status, 'canceled');
    await progress;
    await cancellation;
    await closing;
    await assertRejects(() => f.stream.progress(epoch, 1n), Error, 'closed');
    await assertRejects(
      () => f.stream.waitCompletion(identity(epoch, 1n, 704n)),
      Error,
      'closed',
    );
    await libraryProof();
  } finally {
    flush.resolve();
    await f.close();
  }
});

test('source cutoff refuses foreign identities and has no vacuous progress without peers', async () => {
  const f = await fixture(), source = 0xfedcba9876543210n;
  try {
    await f.stream.appendSource({
      epoch: 1n,
      source,
      segment: 1n,
      pcm: pcm(353),
    });
    await assertRejects(
      () => f.stream.cancelSource(1n, source + 1n),
      Error,
      'refused',
    );
    await assertRejects(
      () => f.stream.cancelSource(1n, source, [{} as AirplayTransport]),
      Error,
      'Foreign',
    );
    await assertRejects(() => f.stream.cancelSource(1n, 0n), RangeError);
    assertEquals(f.stream.epoch, 1n);
    const result = await f.stream.cancelSource(1n, source);
    assert(result.progress);
    assertEquals([
      result.source,
      result.progress.status,
      result.progress.participants,
      result.progress.sourceFrames,
      result.cutoffFrames,
    ], [source, 'waiting', 0n, 0n, 0n]);
    assertEquals(await f.stream.progress(1n, source), null);
    await f.stream.ackCancel(1n);
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('failed RECORD cutoff stays explicitly failed with zero source credit', async () => {
  const f = await fixture({ refuseRecord: () => true });
  try {
    const epoch = 1n;
    await f.stream.appendSource({
      epoch,
      source: 1n,
      segment: 1n,
      pcm: pcm(704),
    });
    await f.activate(0, false);
    const before = (await f.stream.progress(epoch, 1n))!;
    assertEquals(before.status, 'failed');
    const result = await f.stream.cancelSource(epoch, 1n);
    assert(result.progress);
    assertEquals([
      result.progress.status,
      result.progress.error,
      result.progress.sourceFrames,
    ], ['failed', before.error, 0n]);
    assertEquals(f.receivers[0].sessions[0].audioPackets, 0);
    await f.stream.ackCancel(epoch);
    await libraryProof();
  } finally {
    await f.close();
  }
});

test('raw source cutoff is retained across epochs and exact ack ends its lifetime', async () => {
  const lib = raopFfiInternals.loadLibrary(), s = lib.symbols.raop_stream_new();
  assert(s);
  const source = 0xfedcba9876543210n, append = new BigUint64Array(8);
  try {
    assertEquals(
      lib.symbols.raop_stream_append_source(
        s,
        1n,
        source,
        1n,
        pcm(1),
        4n,
        append,
      ),
      0,
    );
    const ids = new BigUint64Array(0),
      progress = new BigUint64Array(15),
      result = new BigUint64Array(6);
    assertEquals(lib.symbols.raop_stream_cancel_source(s, 1n, 0n, ids, 0n), -1);
    assertEquals(
      lib.symbols.raop_stream_cancel_source(s, 1n, source + 1n, ids, 0n),
      -1,
    );
    assertEquals(lib.symbols.raop_stream_epoch(s), 1n);
    assertEquals(
      lib.symbols.raop_stream_cancel_source(s, 1n, source, ids, 0n),
      0,
    );
    await until(
      'source cutoff applied',
      () =>
        lib.symbols.raop_stream_cancel_source_poll(s, 1n, source, progress) ===
          1,
    );
    const saved = progress.slice();
    assertEquals(saved[1], source);
    assertEquals(saved[14], 0n);
    assertEquals(
      lib.symbols.raop_stream_cancel_source_poll(s, 1n, source + 1n, progress),
      -1,
    );
    assertEquals(lib.symbols.raop_stream_cancel_v2(s, 2n, ids, 0n), 0);
    await until(
      'new cancellation ready',
      () =>
        lib.symbols.raop_stream_cancel_poll(s, 2n, result) === 1 &&
        result[2] !== 0n,
    );
    assertEquals(
      lib.symbols.raop_stream_cancel_source_poll(s, 1n, source, progress),
      1,
    );
    assertEquals(progress, saved);
    assertEquals(lib.symbols.raop_stream_cancel_ack(s, 1n), 0);
    assertEquals(
      lib.symbols.raop_stream_cancel_source_poll(s, 1n, source, progress),
      0,
    );
    assertEquals(lib.symbols.raop_stream_cancel_ack(s, 2n), 0);
    await libraryProof();
  } finally {
    assertEquals(await lib.symbols.raop_stream_free(s), 0);
  }
});

test('exact-only injected backends reject timeline calls rather than fabricate progress', async () => {
  let native: AirplayTimelineStream | undefined;
  const devices = createAirplayDevices({
    outputs: createOutputs(),
    stream() {
      native = createFfiStream();
      return { ...native, appendSource: undefined };
    },
  });
  const stream = devices.createStream();
  try {
    await assertRejects(
      () => stream.progress(1n, 1n),
      Error,
      'timeline backend unavailable',
    );
    assertEquals(stream.epoch, 1n);
    assert(native);
    assertEquals(
      (await stream.append({ epoch: 1n, segment: 1n, pcm: pcm(1) }))
        .acceptedFrames,
      1n,
    );
    await libraryProof();
  } finally {
    await stream.close();
    devices.close();
  }
});
