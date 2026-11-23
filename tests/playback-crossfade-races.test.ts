import { assert, assertEquals } from '@std/assert';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';
import type { AirplayTimelineStream } from '../src/boots/airplay-profile.ts';
import type { CrossfadeRecord } from '../src/playback-mix.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import { crossfadeReference } from './helpers/crossfade-proof.ts';
import { exact } from './helpers/concurrent-playback.ts';
import {
  concatenate,
  timelineControl,
  timelineLibraryProof,
  timelinePcm,
  timelineUntil,
} from './helpers/timeline-proof.ts';

function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `crossfade races: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

// Limit real native input for one source in the initial epoch. Even if the
// receiver clock runs ahead, underrun silence can't advance that source or
// complete it. Keep the cap in place across the whole HTTP operation.
function holdSourceAtFrame(source: bigint, frames: bigint) {
  let epoch: bigint | undefined;
  let accepted = 0n;
  let released = false;
  return {
    async append(
      request: Parameters<AirplayTimelineStream['appendSource']>[0],
      append: AirplayTimelineStream['appendSource'],
    ) {
      epoch ??= request.epoch;
      if (released || request.epoch !== epoch || request.source !== source) {
        return await append(request);
      }
      const receipt = await append({
        ...request,
        pcm: request.pcm.subarray(0, Number(frames - accepted) * 4),
      });
      accepted += receipt.acceptedFrames;
      return receipt;
    },
    async at<T>(
      f: Awaited<ReturnType<typeof nativeHttpFixture>>,
      entryId: number,
      run: (heldEpoch: bigint) => Promise<T>,
    ) {
      try {
        await timelineUntil(
          'held source frames are public and presented',
          async () =>
            epoch !== undefined && accepted === frames &&
            f.playback.playerView().current?.id === entryId &&
            (await f.native.progress(epoch, source))?.sourceFrames === frames,
        );
        assert(epoch !== undefined);
        return await run(epoch);
      } finally {
        released = true;
      }
    },
  };
}

test('catalog compatibility waiting prevents an overlap at that boundary', async () => {
  const parts = [timelinePcm(4410), timelinePcm(22050, 2)];
  const records: CrossfadeRecord[] = [];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    durations: [300, 500],
    crossfadeMs: () => 100,
    crossfadeObserved: (record) => records.push(record),
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil(
      'compatibility boundary and real final tail',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(records.map((r) => [r.appliedFrames, r.reason]), [[
      0n,
      'compatibility',
    ]]);
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      concatenate(parts),
    );
  } finally {
    await f.close();
  }
});

test('an incoming live source is never mixed into the healthy catalog tail', async () => {
  const bytes = timelinePcm(22050 + 137);
  const records: CrossfadeRecord[] = [];
  const f = await nativeHttpFixture({
    pcm: bytes,
    web: 'live',
    crossfadeMs: () => 100,
    crossfadeObserved: (record) => records.push(record),
    resolveSource: (_reference, resolve) => resolve(),
  });
  try {
    const c = await timelineControl(f);
    const response = await f.fixture.json(
      '/api/v1/players/1/queue/items',
      'POST',
      {
        references: [{ kind: 'song', id: f.songIds[0] }, {
          kind: 'station',
          id: 'live-B',
        }],
      },
      c.credential,
    );
    assertEquals(response.status, 200, await response.text());
    await c.command('play');
    await timelineUntil(
      'healthy A completes before live failure policy',
      () =>
        f.completions.some((r) => r.source === 1n && r.status === 'complete'),
    );
    assertEquals(records.map((r) => [r.appliedFrames, r.reason]), [[
      0n,
      'ineligible',
    ]]);
    assertEquals(
      f.audio.scheduledRealAudio(
        f.receiver.sessions[0],
        f.receiver.nowMs(),
        0,
        true,
      ),
      bytes,
    );
  } finally {
    await f.close();
  }
});

for (const phase of ['before', 'during', 'after'] as const) {
  for (
    const action of [
      'next',
      'previous',
      'restart',
      'seek',
      'stop',
      'pause',
      'clear',
    ] as const
  ) {
    test(`${action} ${phase} overlap cancels old future and starts an exact solo prefix`, async () => {
      const resumeFuture = Promise.withResolvers<void>();
      let resuming = false;
      const records: CrossfadeRecord[] = [];
      const parts = [
        timelinePcm(44100 + 137),
        timelinePcm(44100 + 19, 2),
        timelinePcm(44100 + 73, 3),
      ];
      const fadeMs = 400;
      const fadeFrames = fadeMs * 44100 / 1000;
      const overlapEnd = BigInt(parts[0].length / 4);
      const overlapStart = overlapEnd - BigInt(fadeFrames);
      const primary = phase === 'after' ? 1 : 0;
      const primarySource = BigInt(primary + 1);
      // Native progress counts presented frames (an exclusive end). At
      // overlapStart no mixed frame has played; halfway into the fade the
      // mix is audible but A cannot finish. After A, hold B in its solo body.
      const heldFrames = phase === 'before'
        ? overlapStart
        : phase === 'during'
        ? overlapStart + BigInt(fadeFrames / 2)
        : BigInt(fadeFrames / 2);
      const gate = holdSourceAtFrame(primarySource, heldFrames);
      const f = await nativeHttpFixture({
        pcm: parts[0],
        additionalPcm: parts.slice(1),
        persist: true,
        crossfadeMs: () => fadeMs,
        crossfadeObserved: (record) => records.push(record),
        append: gate.append,
        async beforeDecode(path) {
          // Keep the newly planned natural successor unavailable while checking
          // the resumed solo prefix, independently of any old accepted mix.
          const future = phase === 'after' ? 'next-1.wav' : 'next-0.wav';
          if (resuming && path.endsWith(future)) await resumeFuture.promise;
        },
      });
      try {
        const c = await timelineControl(f);
        await c.add();
        const entries = f.playback.queueView().items;
        await c.command('play');
        let index = primary, offset = 0;
        if (action === 'next') index++;
        if (action === 'previous') index = Math.max(0, primary - 1);
        if (action === 'seek') offset = 13230;
        const { oldSession, oldBoundary, cutoffIndex, epoch } = await gate.at(
          f,
          entries[primary].id,
          async (epoch) => {
            const oldBoundaryMix = () =>
              records.find((r) =>
                r.outgoingEntryId === entries[0].id &&
                r.incomingEntryId === entries[1].id
              );
            await timelineUntil(
              'old A/B overlap is planned',
              () => !!oldBoundaryMix(),
            );
            const mixed = oldBoundaryMix();
            assert(mixed, 'old A/B boundary planned an overlap');
            assertEquals(mixed.appliedFrames, BigInt(fadeFrames));
            assertEquals(mixed.reason, 'applied');
            const oldSession = f.receiver.sessions.at(-1)!;
            const oldBoundary = oldSession.wire.findLastIndex((e) =>
              e.kind === 'record' || e.kind === 'flush'
            );
            const cutoffIndex = f.capturedCutoffs.length;
            if (action === 'clear') await c.remove();
            else {
              await c.command(
                action,
                action === 'seek' ? { positionMs: 300 } : {},
              );
            }
            return { oldSession, oldBoundary, cutoffIndex, epoch };
          },
        );
        const bookmarks = action === 'stop' || action === 'pause';
        const saved = bookmarks ? await f.saved() : undefined;
        const admission = f.capturedCutoffs[cutoffIndex];
        if (admission) {
          assertEquals(admission.epoch, epoch);
          assertEquals(admission.source, primarySource);
          assertEquals(admission.progress.sourceFrames, heldFrames);
        }
        if (action === 'clear') {
          assertEquals((await c.current()).state, 'stop');
          await c.add([f.songIds[2]]);
          index = 2;
          await c.command('play');
        } else if (bookmarks) {
          assert(
            admission,
            'bookmark controls capture the primary at admission',
          );
          const frames = Number(admission.progress.sourceFrames) +
            (phase === 'after' ? fadeFrames : 0);
          assertEquals(saved?.positionMs, Math.floor(frames * 1000 / 44100));
          assertEquals(saved?.currentIndex, primary);
          offset = Math.round(saved!.positionMs * 44100 / 1000);
          resuming = true;
          await c.command('play');
        }
        const replacement = () => {
          const session = f.receiver.sessions.at(-1);
          if (!session) return null;
          const boundary = session.wire.findLastIndex((e) =>
            e.kind === 'record' || e.kind === 'flush'
          );
          if (session === oldSession && boundary <= oldBoundary) return null;
          const event = session.wire[boundary];
          if (!event || event.kind !== 'record' && event.kind !== 'flush') {
            return null;
          }
          const match = /seq=(\d+);rtptime=(\d+)/.exec(event.rtpInfo)!;
          const sequence = Number(match[1]), anchor = Number(match[2]);
          const packets = new Map<number, Uint8Array>();
          for (const event of session.wire.slice(boundary + 1)) {
            if (event.kind !== 'audio') continue;
            const header = new DataView(
              event.data.buffer,
              event.data.byteOffset,
              event.data.length,
            );
            const frame = (header.getUint32(4) - anchor + 2 ** 32) % 2 ** 32;
            if (
              frame >= 12 * 352 || frame % 352 ||
              header.getUint16(2) !== (sequence + frame / 352) % 65536
            ) continue;
            const payload = event.data.subarray(12),
              previous = packets.get(frame);
            if (previous) {
              assertEquals(payload, previous, 'matching RTP duplicate agrees');
            } else packets.set(frame, payload);
          }
          if (packets.size < 12) return null;
          return Array.from({ length: 12 }, (_, i) => packets.get(i * 352)!);
        };
        await timelineUntil(
          'replacement has real packet coverage',
          () => replacement() !== null,
        );
        const session = f.receiver.sessions.at(-1)!;
        const actual = decodeReceiverAudio(session.sdp, replacement()!);
        const expected = parts[index].subarray(
          offset * 4,
          (offset + 12 * 352) * 4,
        );
        assertEquals(actual.length, expected.length);
        assertEquals(
          actual.findIndex((byte, i) => byte !== expected[i]),
          -1,
          'the command never fades into its target',
        );
        await timelineUntil('replacement prefix is scheduled', () => {
          const replay = renderScheduledAudio(session, f.receiver.nowMs());
          const epoch = session.wire.filter((e) =>
            e.kind === 'record' || e.kind === 'flush'
          ).length;
          const pcm = concatenate(
            replay.ranges.filter((r) =>
              r.epoch === epoch
            ).map((r) => r.pcm),
          );
          return pcm.length >= expected.length;
        });
        const replay = renderScheduledAudio(session, f.receiver.nowMs());
        assertEquals(replay.issues, []);
        const replacementEpoch = session.wire.filter((e) =>
          e.kind === 'record' || e.kind === 'flush'
        ).length;
        assertEquals(
          concatenate(
            replay.ranges.filter((r) => r.epoch === replacementEpoch).map((r) =>
              r.pcm
            ),
          ).subarray(0, expected.length),
          expected,
        );
        await timelineLibraryProof();
      } finally {
        resumeFuture.resolve();
        await f.close();
      }
    });
  }
}

test('slow incoming preparation never holds back the outgoing real tail for a fade', async () => {
  const held = Promise.withResolvers<void>();
  let blocked = false;
  const parts = [timelinePcm(22050 + 137), timelinePcm(22050 + 19, 2)];
  const records: CrossfadeRecord[] = [];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    crossfadeMs: () => 100,
    crossfadeObserved: (record) => records.push(record),
    async beforeDecode(path) {
      if (path.endsWith('next-0.wav')) {
        blocked = true;
        await held.promise;
      }
    },
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil('B is held', () => blocked);
    await timelineUntil(
      'A seals without waiting for a fade head',
      () => !!f.key && f.key.source === 1n,
    );
    await timelineUntil(
      'A tail completed on its schedule',
      () =>
        f.completions.some((r) => r.status === 'complete' && r.source === 1n),
    );
    assertEquals(
      f.audio.scheduledRealAudio(
        f.receiver.sessions[0],
        f.receiver.nowMs(),
        0,
        true,
      ),
      parts[0],
    );
    held.resolve();
    await timelineUntil(
      'B drains',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      concatenate(parts),
    );
    assertEquals(records.map((r) => r.appliedFrames), [0n]);
  } finally {
    held.resolve();
    await f.close();
  }
});

test('two speakers receive the same mixed schedule without changing absolute volume', async () => {
  const parts = [timelinePcm(44100 + 137), timelinePcm(22050 + 19, 2)];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    crossfadeMs: () => 100,
    receiverCount: 2,
  });
  try {
    f.outputs.update('1', { volume: 37 });
    f.outputs.update('2', { volume: 82 });
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil(
      'both speakers finish the mixed tail',
      () => f.playback.playerView().state === 'stop',
    );
    const expected = crossfadeReference(parts, 4410).pcm;
    for (const receiver of f.receivers) {
      assertEquals(
        f.audio.scheduledRealAudio(receiver.sessions[0], receiver.nowMs()),
        expected,
      );
      assert(receiver.sessions[0].volumeParams.length > 0);
      assertEquals(
        new Set(receiver.sessions[0].volumeParams).size,
        1,
        'natural mixing does not change the absolute receiver volume',
      );
    }
    assertEquals(f.outputs.list().map((o) => o.volume), [37, 82]);
    assert(
      f.receivers[0].sessions[0].volumeParams[0] !==
        f.receivers[1].sessions[0].volumeParams[0],
    );
  } finally {
    await f.close();
  }
});

for (const repeat of ['off', 'single', 'all'] as const) {
  test(`repeat=${repeat} and consume preserve occurrence policy with overlap mapping`, async () => {
    const parts = [timelinePcm(22050 + 137), timelinePcm(22050 + 19, 2)];
    const f = await nativeHttpFixture({
      pcm: parts[0],
      additionalPcm: [parts[1]],
      crossfadeMs: () => 100,
    });
    try {
      const c = await timelineControl(f);
      await c.add();
      const entries = f.playback.queueView().items;
      await c.modes({ repeat, consume: true });
      await c.command('play');
      if (repeat === 'off') {
        await timelineUntil(
          'consume drains both items once',
          () => f.playback.playerView().state === 'stop',
        );
        assertEquals(f.playback.queueView().items, []);
        assertEquals(
          f.audio.scheduledRealAudio(
            f.receiver.sessions[0],
            f.receiver.nowMs(),
          ),
          crossfadeReference(parts, 4410).pcm,
        );
      } else {
        const expectedParts = repeat === 'single'
          ? [parts[0], parts[0], parts[0]]
          : [parts[0], parts[1], parts[0]];
        const frames = expectedParts[0].length / 4 +
          expectedParts[1].length / 4 - 4410;
        await timelineUntil(
          'two distinct source incarnations complete',
          () => (f.audio.epochs[0]?.completedThrough ?? 0n) >= BigInt(frames),
        );
        assertEquals(
          f.playback.queueView().items.map((e) => e.id),
          entries.map((e) => e.id),
        );
        const expected = crossfadeReference(expectedParts, 4410).pcm.subarray(
          0,
          frames * 4,
        );
        assertEquals(
          f.audio.scheduledRealAudio(
            f.receiver.sessions[0],
            f.receiver.nowMs(),
            0,
            true,
          ),
          expected,
        );
      }
      assertEquals(f.receiver.sessions.length, 1);
      assertEquals(f.receiver.sessions[0].flushes, 0);
    } finally {
      await f.close();
    }
  });
}

test('removing a successor already mixed into A discards that future before reopening solo A', async () => {
  const parts = [
    timelinePcm(44100 + 137),
    timelinePcm(44100 + 19, 2),
    timelinePcm(44100 + 73, 3),
  ];
  const heldFrames = BigInt(parts[0].length / 4 - 2205);
  const gate = holdSourceAtFrame(1n, heldFrames);
  const replacementHead = Promise.withResolvers<void>();
  const reopenedAt = Math.floor(Number(heldFrames) * 1000 / 44100);
  const reopenedFrames = parts[0].length / 4 -
    Math.round(reopenedAt * 44100 / 1000);
  let decodedHead = 0n;
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: parts.slice(1),
    crossfadeMs: () => 100,
    append: gate.append,
    async beforeDecode(path, startMs) {
      // The cutoff leaves less than a fade's worth of A and no queued solo
      // PCM. Give the replacement mix its real C head before A can reach EOF.
      if (path.endsWith('/source.wav') && startMs > 0) {
        await replacementHead.promise;
      }
    },
    afterDecodedChunk(path, frames) {
      if (path.endsWith('/next-1.wav')) {
        decodedHead += frames;
        if (decodedHead > BigInt(reopenedFrames)) replacementHead.resolve();
      }
      return Promise.resolve();
    },
  });
  const published: number[] = [];
  const off = f.fixture.notify!.subscribe(() => {
    const id = f.playback.playerView().current?.id;
    if (id) published.push(id);
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    const entries = f.playback.queueView().items;
    await c.command('play');
    const epoch = await gate.at(f, entries[0].id, async (epoch) => {
      await c.remove(entries[1].id);
      return epoch;
    });
    await timelineUntil(
      'replanned A/C finish',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(published.includes(entries[1].id), false);
    const cutoff = f.capturedCutoffs[0];
    assertEquals(cutoff.epoch, epoch);
    assertEquals(cutoff.source, 1n);
    assertEquals(cutoff.progress.sourceFrames, heldFrames);
    const start = Math.round(
      Math.floor(Number(cutoff.progress.sourceFrames) * 1000 / 44100) * 44100 /
        1000,
    );
    const expected =
      crossfadeReference([parts[0].subarray(start * 4), parts[2]], 4410).pcm;
    exact(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs(), 1),
      expected,
    );
  } finally {
    replacementHead.resolve();
    off();
    await f.close();
  }
});

test('late join declares suffix coverage of the same mixed stream', async () => {
  const parts = [timelinePcm(88200 + 137), timelinePcm(44100 + 19, 2)];
  const records: CrossfadeRecord[] = [];
  const gate = holdSourceAtFrame(1n, 352n * 30n);
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    crossfadeMs: () => 200,
    crossfadeObserved: (record) => records.push(record),
    append: gate.append,
    receiverCount: 2,
    receiverSelection: [true, false],
    receiver: { recoverAudioGaps: true },
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    const [entry] = f.playback.queueView().items;
    await c.command('play');
    // The prefix has already played, so b20 cannot backfill it. Keep the
    // remainder unavailable until the newly selected receiver has joined.
    await gate.at(f, entry.id, async () => {
      await f.own('/outputs/2', 'PUT', { selected: true });
      await timelineUntil(
        'late receiver records',
        () =>
          f.receivers[1].sessions[0]?.wire.some((e) => e.kind === 'record') ===
            true,
      );
    });
    await timelineUntil(
      'both natural tails finish',
      () => f.playback.playerView().state === 'stop',
    );
    const first = f.receiver.sessions[0].wire.find((e) => e.kind === 'record');
    const joined = f.receivers[1].sessions[0],
      second = joined.wire.find((e) => e.kind === 'record');
    assert(first?.kind === 'record' && second?.kind === 'record');
    const offset = (Number(/rtptime=(\d+)/.exec(second.rtpInfo)![1]) -
      Number(/rtptime=(\d+)/.exec(first.rtpInfo)![1]) + 2 ** 32) % 2 ** 32;
    const mixed = crossfadeReference(parts, 8820).pcm;
    const [epoch] = f.audio.epochs;
    const end = Number(epoch.completedThrough);
    assert(
      offset < end,
      'the joining receiver has a nonempty suffix',
    );
    // A held input may add underrun silence. Prove the primary's real PCM
    // against the reference (and its labeled silence is zero), then compare
    // the joining receiver's exact transport suffix, including that silence.
    const original = f.receiver.sessions[0];
    exact(f.audio.scheduledRealAudio(original, f.receiver.nowMs()), mixed);
    const expected = renderScheduledAudio(original, f.receiver.nowMs()).pcm
      .subarray(offset * 4, end * 4);
    assertEquals(expected.length, (end - offset) * 4);
    const replay = renderScheduledAudio(joined, f.receivers[1].nowMs());
    assertEquals(replay.issues, []);
    assertEquals(records.map((r) => r.appliedFrames), [8820n]);
    exact(replay.pcm.subarray(0, expected.length), expected);
    assert(offset > 0, 'join never claims the earlier prefix');
  } finally {
    await f.close();
  }
});

test('decoder starvation freezes the primary and resumes the exact mixed stream', async () => {
  const held = Promise.withResolvers<void>();
  const parts = [timelinePcm(44100 + 137), timelinePcm(44100 + 19, 2)];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    afterFirstChunk: held.promise,
    crossfadeMs: () => 1,
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil(
      'a real source prefix has played',
      () => f.playback.playerView().itemProgressMs > 0,
    );
    await timelineUntil(
      'source progress stops at starvation',
      () => f.playback.playerView().playbackRate === 0,
    );
    const view = f.playback.playerView();
    await new Promise((done) => setTimeout(done, 100));
    assertEquals(f.playback.playerView().itemProgressMs, view.itemProgressMs);
    assertEquals(f.playback.playerView().current?.id, view.current?.id);
    held.resolve();
    await timelineUntil(
      'both resumed tails drain',
      () => f.playback.playerView().state === 'stop',
    );
    const expected = crossfadeReference(parts, 44).pcm;
    assertEquals(f.audio.realAudio(f.receiver.sessions[0]), expected);
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      expected,
    );
  } finally {
    held.resolve();
    await f.close();
  }
});

for (const cleanupRejects of [false, true]) {
  test(`a failed incoming head${cleanupRejects ? ' with failed cleanup' : ''} cannot contaminate A or consume B before it is due`, async () => {
    const parts = [timelinePcm(44100 + 137), timelinePcm(44100 + 19, 2)];
    let failed = false;
    let cleanupCalls = 0;
    const publishCompletion = Promise.withResolvers<void>();
    const f = await nativeHttpFixture({
      pcm: parts[0],
      additionalPcm: [parts[1]],
      crossfadeMs: () => 100,
      completionPublication: () => publishCompletion.promise,
      decoderReturn(path) {
        if (cleanupRejects && path.endsWith('next-0.wav')) {
          cleanupCalls++;
          return Promise.reject(new Error('B decoder cleanup rejected'));
        }
        return Promise.resolve();
      },
      afterDecodedChunk(path) {
        if (path.endsWith('next-0.wav')) {
          failed = true;
          return Promise.reject(
            new Error('incoming decoder failed after its first chunk'),
          );
        }
        return Promise.resolve();
      },
    });
    const outcomes: { entryId: number; outcome: string }[] = [];
    const report = f.playback.reportSourceOutcome;
    f.playback.reportSourceOutcome = (source, outcome) => {
      outcomes.push({ entryId: source.entryId, outcome });
      return report(source, outcome);
    };
    try {
      const c = await timelineControl(f);
      await c.add();
      await c.modes({ consume: true });
      const entries = f.playback.queueView().items;
      await c.command('play');
      await timelineUntil('incoming failure is retained', () => failed);
      assertEquals((await c.current()).current.entryId, entries[0].id);
      assertEquals(f.playback.queueView().items.length, 2);
      publishCompletion.resolve();
      await timelineUntil(
        'failed B becomes due and pauses',
        () => f.playback.playerView().state === 'pause',
      );
      assertEquals((await c.current()).current.entryId, entries[1].id);
      assertEquals((await c.current()).positionMs, 0);
      assert(
        f.completions.some((r) => r.source === 1n && r.status === 'complete'),
      );
      assertEquals(
        outcomes.filter((r) => r.outcome === 'decode-error').map((r) =>
          r.entryId
        ),
        [entries[1].id],
      );
      assertEquals(cleanupCalls, cleanupRejects ? 1 : 0);
      assertEquals(f.playback.queueView().items.map((e) => e.id), [
        entries[1].id,
      ]);
      assertEquals(
        f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
        parts[0],
      );
    } finally {
      publishCompletion.resolve();
      await f.close();
    }
  });
}

test('ready outgoing samples play while their decoder is stalled', async () => {
  const held = Promise.withResolvers<void>();
  let buffered = 0n, blocked = false;
  const parts = [timelinePcm(44100 + 137), timelinePcm(44100 + 19, 2)];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    crossfadeMs: () => 100,
    async afterDecodedChunk(path, frames) {
      if (!path.endsWith('next-0.wav')) return;
      buffered += frames;
      if (buffered >= 5410n && !blocked) {
        blocked = true;
        await held.promise;
      }
    },
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil(
      'B decoder stalled after more than its incoming head',
      () => blocked,
    );
    const available = buffered;
    await timelineUntil(
      'all already-decoded B samples reach their scheduled consumer',
      async () => {
        const progress = await f.native.progress(f.native.epoch, 2n);
        return !!progress && progress.sourceFrames + 4410n >= available;
      },
    );
    const expected = crossfadeReference([
      parts[0],
      parts[1].subarray(0, Number(available) * 4),
    ], 4410).pcm;
    const replay = renderScheduledAudio(
      f.receiver.sessions[0],
      f.receiver.nowMs(),
    );
    assertEquals(replay.issues, []);
    assertEquals(
      replay.pcm.subarray(0, expected.length),
      expected,
      'retaining a fade tail does not cause an early underrun',
    );
    assert(
      (await c.current()).positionMs >=
        Math.floor(Number(available) * 1000 / 44100),
    );
    held.resolve();
    await timelineUntil(
      'resumed decoder and final tail drain',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      crossfadeReference(parts, 4410).pcm,
    );
  } finally {
    held.resolve();
    await f.close();
  }
});

test('held startup PCM plays before a stalled second decoder read resumes', async () => {
  const held = Promise.withResolvers<void>();
  const parts = [timelinePcm(88200 + 137), timelinePcm(44100 + 19, 2)];
  let available = 0n;
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    crossfadeMs: () => 400,
    async afterDecodedChunk(path, frames) {
      if (path.endsWith('next-0.wav') || available) return;
      available = frames;
      await held.promise;
    },
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil(
      'startup decoder stalls with a short held chunk',
      () => available > 0n,
    );
    assert(available < 17640n, 'the first chunk fits entirely inside the hold');
    await timelineUntil(
      'ready startup PCM reaches its scheduled consumer',
      async () => {
        const progress = await f.native.progress(f.native.epoch, 1n);
        return progress?.sourceFrames === available;
      },
    );
    const startup = renderScheduledAudio(
      f.receiver.sessions[0],
      f.receiver.nowMs(),
    );
    assertEquals(startup.issues, []);
    assertEquals(
      startup.pcm.subarray(0, Number(available) * 4),
      parts[0].subarray(0, Number(available) * 4),
    );
    held.resolve();
    await timelineUntil(
      'resumed startup and natural overlap drain',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      crossfadeReference(parts, 17640).pcm,
    );
  } finally {
    held.resolve();
    await f.close();
  }
});

test('removing an incoming lease during its head wait selects the following track', async () => {
  const held = Promise.withResolvers<void>();
  const resumeWait = Promise.withResolvers<void>();
  let waiting = false;
  let blocked = false;
  let incoming: AbortSignal | undefined;
  const parts = [
    timelinePcm(44100 + 137),
    timelinePcm(44100 + 19, 2),
    timelinePcm(44100 + 73, 3),
  ];
  const records: CrossfadeRecord[] = [];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: parts.slice(1),
    crossfadeMs: () => 100,
    crossfadeObserved: (record) => records.push(record),
    async crossfadeWaiting() {
      waiting = true;
      await resumeWait.promise;
    },
    async afterDecodedChunk(path, _frames, signal) {
      if (path.endsWith('next-0.wav') && !blocked) {
        incoming = signal;
        blocked = true;
        await held.promise;
      }
    },
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    const entries = f.playback.queueView().items;
    await c.command('play');
    await timelineUntil(
      'the reader entered B head wait after its pre-wait lease guard',
      () => waiting,
    );
    assert(blocked);
    assert(incoming, 'the held incoming decoder has a cancellation signal');
    const removing = c.remove(entries[1].id);
    await timelineUntil(
      'B lease revoked during the head wait',
      () => incoming!.aborted,
    );
    resumeWait.resolve();
    held.resolve();
    await removing;
    await timelineUntil(
      'A and replacement C drain',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(records.map((r) => r.incomingEntryId), [entries[2].id]);
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      crossfadeReference([parts[0], parts[2]], 4410).pcm,
    );
  } finally {
    resumeWait.resolve();
    held.resolve();
    await f.close();
  }
});

test('catalog decoder hooks also apply with explicit web sources', async () => {
  let observed = 0n;
  const bytes = timelinePcm(22050 + 137);
  const f = await nativeHttpFixture({
    pcm: bytes,
    web: 'finite',
    afterDecodedChunk(_path, frames) {
      observed += frames;
      return Promise.resolve();
    },
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil(
      'catalog source drains in web-enabled fixture',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(observed, BigInt(bytes.length / 4));
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      bytes,
    );
  } finally {
    await f.close();
  }
});
