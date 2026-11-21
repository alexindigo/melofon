import { assert, assertEquals } from '@std/assert';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';

const sleep = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(label: string, check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 15000;
  while (!await check()) {
    assert(performance.now() < deadline, `timed out: ${label}`);
    await sleep();
  }
}
function pcm(frames = 4410, value = 1000) {
  const bytes = new Uint8Array(frames * 4);
  const view = new DataView(bytes.buffer);
  for (let at = 0; at < bytes.length; at += 2) view.setInt16(at, value, true);
  return bytes;
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `playback review regression: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

test('late old-decoder cleanup failure cannot retire the seek replacement', async () => {
  const held = Promise.withResolvers<void>();
  let returns = 0, entered = false, failed = false;
  const f = await nativeHttpFixture({
    pcm: pcm(441000),
    async decoderReturn() {
      if (returns++ !== 0) return;
      entered = true;
      await held.promise;
      failed = true;
      throw new Error('superseded decoder cleanup fault');
    },
  });
  try {
    await f.play();
    await until(
      'old source audio',
      () => f.receiver.sessions[0]?.audioPackets >= 8,
    );
    const session = f.receiver.sessions[0];
    await f.playback.seek({ positionMs: 0 });
    await until(
      'old decoder return and replacement audio',
      () => entered && session.flushes > 0 && f.origins.length === 2,
    );
    const before = session.audioPackets;
    held.resolve();
    await until('old cleanup rejection', () => failed);
    await until(
      'replacement continues after old failure',
      () => session.audioPackets >= before + 8,
    );
    assertEquals(f.playback.playerView().state, 'play');
    assertEquals(session.closedAtMs, null);
    assertEquals(f.receiver.sessions.length, 1);
  } finally {
    held.resolve();
    await f.close();
  }
});

test('discarded future decoder cleanup cannot become the primary decode outcome', async () => {
  let returned = false, head = false;
  const bytes = pcm(132300);
  const f = await nativeHttpFixture({
    pcm: bytes,
    additionalPcm: [pcm(4410, 2000)],
    decoderHead(path) {
      if (path.endsWith('/next-0.wav')) head = true;
    },
    decoderReturn(path) {
      if (path.endsWith('/next-0.wav')) {
        returned = true;
        return Promise.reject(new Error('discarded future cleanup fault'));
      }
      return Promise.resolve();
    },
  });
  try {
    const entries = await f.playback.queueAddReferences(
      f.songIds.map((id) => ({ kind: 'song' as const, id })),
    );
    await f.playback.play();
    await until('prefetched decoder head', () => head);
    await f.playback.queueRemove(entries[1].id);
    await until(
      'discarded cleanup and primary completion',
      () => returned && f.playback.playerView().state === 'stop',
    );
    assertEquals(f.completions.at(-1)?.status, 'complete');
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      bytes,
    );
    await until(
      'first stream release',
      () => f.receiver.sessions[0].closedAtMs !== null,
    );
    await f.playback.play();
    await until(
      'new playback after discarded-source cleanup fault',
      () => f.receiver.sessions[1]?.audioPackets >= 8,
    );
    assertEquals(f.playback.playerView().state, 'play');
  } finally {
    await f.close();
  }
});

for (const declaredMs of [null, 0]) {
  test(`catalog duration ${declaredMs} ends cleanly without advancing`, async () => {
    const bytes = pcm();
    const f = await nativeHttpFixture({
      pcm: bytes,
      additionalPcm: [pcm(4410, 2000)],
      declaredMs,
    });
    try {
      await f.play(false);
      await f.play(false);
      const first = f.playback.queueView().items[0].id;
      await f.playback.play();
      await until(
        'unknown-duration terminal pause',
        () => f.playback.playerView().state === 'pause',
      );
      assertEquals(f.playback.playerView().current?.id, first);
      assertEquals(f.playback.queueView().items.length, 2);
      assert(f.token?.signal.aborted, 'the completed source lease is revoked');
      await until(
        'completion acknowledgement and receiver release',
        () =>
          f.ackStates.length > 0 &&
          f.receiver.sessions.every((session) => session.closedAtMs !== null),
      );
      assertEquals(
        f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
        bytes,
      );
    } finally {
      await f.close();
    }
  });
}

for (const next of ['remove', 'move'] as const) {
  test(`zero-frame backpressured successor ${next} replans from sealed primary`, async () => {
    const bytes = pcm();
    let first: bigint | undefined, blocked = false, release = false;
    const f = await nativeHttpFixture({
      pcm: bytes,
      additionalPcm: [pcm(4410, 2000), pcm(4410, 3000)],
      async append(request, append) {
        first ??= request.source;
        if (request.source !== first && !release) {
          blocked = true;
          return {
            streamId: f.native.id,
            epoch: request.epoch,
            segment: request.segment,
            source: request.source,
            sourceOffset: 0n,
            inputOffset: 0n,
            acceptedFrames: 0n,
            status: 'backpressure',
          };
        }
        return await append(request);
      },
    });
    try {
      const entries = await f.playback.queueAddReferences(
        f.songIds.map((id) => ({ kind: 'song' as const, id })),
      );
      await f.playback.play();
      await until('first successor append backpressure', () => blocked);
      const generation = f.playback.playerView().generation;
      if (next === 'remove') await f.playback.queueRemove(entries[1].id);
      else await f.playback.queueMove(entries[1].id, 2);
      assertEquals(f.playback.playerView().generation, generation);
      release = true;
      await until(
        'replanned queue exhaustion',
        () => f.playback.playerView().state === 'stop',
      );
      const expected = new Uint8Array(
        bytes.length * (next === 'remove' ? 2 : 3),
      );
      expected.set(bytes);
      expected.set(pcm(4410, 3000), bytes.length);
      if (next === 'move') expected.set(pcm(4410, 2000), bytes.length * 2);
      assertEquals(
        f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
        expected,
      );
      assertEquals(f.receiver.sessions.length, 1);
    } finally {
      release = true;
      await f.close();
    }
  });
}

for (const outcome of ['failure', 'missing'] as const) {
  test(`later successor preparation ${outcome} leaves no continuous-mode hang`, async () => {
    let armed = false;
    const bytes = pcm();
    const f = await nativeHttpFixture({
      pcm: bytes,
      web: 'finite',
      async resolveSource(reference, resolve) {
        if (armed && reference.kind === 'station' && reference.id === 'C') {
          if (outcome === 'failure') throw new Error('C preparation fault');
          return null;
        }
        return await resolve();
      },
    });
    try {
      await f.play(false);
      await f.playback.queueAddReferences([
        { kind: 'station', id: 'B' },
        { kind: 'station', id: 'C' },
      ]);
      armed = true;
      await f.playback.play();
      await until(
        'terminal state after healthy prefix',
        () => f.playback.playerView().state !== 'play',
      );
      assertEquals(
        f.playback.playerView().state,
        outcome === 'failure' ? 'pause' : 'stop',
      );
      await until(
        'both prefix completion acknowledgements',
        () => f.ackStates.length === 2,
      );
      assertEquals(f.ackStates.length, 2);
      const expected = new Uint8Array(bytes.length * 2);
      expected.set(bytes);
      expected.set(bytes, bytes.length);
      assertEquals(
        f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
        expected,
      );
    } finally {
      await f.close();
    }
  });
}
