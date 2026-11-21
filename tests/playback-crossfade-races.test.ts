import { assert, assertEquals } from '@std/assert';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';
import type { CrossfadeRecord } from '../src/playback-mix.ts';
import { decodeReceiverAudio } from './helpers/raop-audio-consumer.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import { crossfadeReference } from './helpers/crossfade-proof.ts';
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
      const f = await nativeHttpFixture({
        pcm: parts[0],
        additionalPcm: parts.slice(1),
        persist: true,
        crossfadeMs: () => 400,
        crossfadeObserved: (record) => records.push(record),
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
        await timelineUntil(
          'mixed future accepted',
          () => !!f.key && f.key.source >= 2n,
        );
        const mixed = records.find((r) =>
          r.outgoingEntryId === entries[0].id &&
          r.incomingEntryId === entries[1].id
        );
        assert(
          mixed && mixed.appliedFrames > 0n,
          'old A/B boundary really mixed',
        );
        assertEquals(mixed.reason, 'applied');
        const fadeFrames = Number(mixed.appliedFrames);
        const overlapStart = BigInt(parts[0].length / 4) - mixed.appliedFrames;
        const overlapEnd = BigInt(parts[0].length / 4);
        if (phase === 'during') {
          await timelineUntil(
            'primary is inside its scheduled overlap',
            async () => {
              const progress = await f.native.progress(f.native.epoch, 1n);
              return !!progress &&
                progress.sourceFrames > overlapStart &&
                progress.sourceFrames < overlapEnd;
            },
          );
          assertEquals(f.playback.playerView().current?.id, entries[0].id);
        }
        if (phase === 'after') {
          await timelineUntil(
            'B is public with overlapped head',
            () => f.playback.playerView().current?.id === entries[1].id,
          );
        }
        const primary = phase === 'after' ? 1 : 0;
        const oldSession = f.receiver.sessions.at(-1)!;
        const oldBoundary = oldSession.wire.findLastIndex((e) =>
          e.kind === 'record' || e.kind === 'flush'
        );
        let index = primary, offset = 0;
        if (action === 'next') index++;
        if (action === 'previous') index = Math.max(0, primary - 1);
        if (action === 'seek') offset = 13230;
        const beforeCommand = await f.native.progress(
          f.native.epoch,
          BigInt(primary + 1),
        );
        assert(beforeCommand);
        if (phase === 'before') {
          assert(beforeCommand.sourceFrames < overlapStart);
        } else if (phase === 'during') {
          assert(
            beforeCommand.sourceFrames > overlapStart &&
              beforeCommand.sourceFrames < overlapEnd,
          );
        }
        const cutoffIndex = f.capturedCutoffs.length;
        if (action === 'clear') {
          await c.remove();
          assertEquals((await c.current()).state, 'stop');
          await c.add([f.songIds[2]]);
          index = 2;
          await c.command('play');
        } else {
          await c.command(action, action === 'seek' ? { positionMs: 300 } : {});
          if (action === 'stop' || action === 'pause') {
            const saved = await f.saved();
            const cutoff = f.capturedCutoffs.at(-1)?.progress;
            assert(cutoff);
            const frames = Number(cutoff.sourceFrames) +
              (phase === 'after' ? fadeFrames : 0);
            assertEquals(saved?.positionMs, Math.floor(frames * 1000 / 44100));
            assertEquals(saved?.currentIndex, primary);
            offset = Math.round(saved!.positionMs * 44100 / 1000);
            resuming = true;
            await c.command('play');
          }
        }
        const admission = f.capturedCutoffs[cutoffIndex]?.progress;
        if (action === 'stop' || action === 'pause') {
          assert(
            admission,
            'bookmark controls capture the primary at admission',
          );
        }
        if (admission && phase === 'before') {
          assert(
            admission.sourceFrames < overlapStart,
            'control precedes overlap',
          );
        } else if (admission && phase === 'during') {
          assert(
            admission.sourceFrames > overlapStart &&
              admission.sourceFrames < overlapEnd,
            'control is admitted inside the measured overlap',
          );
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
        const epoch = session.wire.filter((e) =>
          e.kind === 'record' || e.kind === 'flush'
        ).length;
        assertEquals(
          concatenate(
            replay.ranges.filter((r) => r.epoch === epoch).map((r) => r.pcm),
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
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: parts.slice(1),
    crossfadeMs: () => 100,
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
    await timelineUntil(
      'B mixed into accepted A tail',
      () => !!f.key && f.key.source >= 2n,
    );
    await c.remove(entries[1].id);
    await timelineUntil(
      'replanned A/C finish',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(published.includes(entries[1].id), false);
    const cutoff = f.capturedCutoffs[0].progress;
    assert(cutoff);
    const start = Math.round(
      Math.floor(Number(cutoff.sourceFrames) * 1000 / 44100) * 44100 / 1000,
    );
    const expected =
      crossfadeReference([parts[0].subarray(start * 4), parts[2]], 4410).pcm;
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs(), 1),
      expected,
    );
  } finally {
    off();
    await f.close();
  }
});

test('late join declares suffix coverage of the same mixed stream', async () => {
  const parts = [timelinePcm(88200 + 137), timelinePcm(44100 + 19, 2)];
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    crossfadeMs: () => 200,
    receiverCount: 2,
    receiverSelection: [true, false],
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil(
      'outgoing prefix sent',
      () => (f.receiver.sessions[0]?.audioPackets ?? 0) >= 30,
    );
    await f.own('/outputs/2', 'PUT', { selected: true });
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
    assert(
      offset < mixed.length / 4,
      'the joining receiver has a nonempty suffix',
    );
    const expected = mixed.subarray(offset * 4);
    const replay = renderScheduledAudio(joined, f.receivers[1].nowMs());
    assertEquals(replay.issues, []);
    assertEquals(replay.pcm.subarray(0, expected.length), expected);
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

test('a failed incoming head cannot contaminate A or consume B before it is due', async () => {
  const parts = [timelinePcm(44100 + 137), timelinePcm(44100 + 19, 2)];
  let failed = false;
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    crossfadeMs: () => 100,
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
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.modes({ consume: true });
    const entries = f.playback.queueView().items;
    await c.command('play');
    await timelineUntil('incoming failure is retained', () => failed);
    assertEquals((await c.current()).current.entryId, entries[0].id);
    assertEquals(f.playback.queueView().items.length, 2);
    await timelineUntil(
      'failed B becomes due and pauses',
      () => f.playback.playerView().state === 'pause',
    );
    assertEquals((await c.current()).current.entryId, entries[1].id);
    assertEquals((await c.current()).positionMs, 0);
    assertEquals(f.playback.queueView().items.map((e) => e.id), [
      entries[1].id,
    ]);
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      parts[0],
    );
  } finally {
    await f.close();
  }
});

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
      'A reaches the boundary while B head is stalled',
      async () => {
        const source = await f.native.source(f.native.epoch, 1n);
        return blocked &&
          source?.acceptedFrames === BigInt(parts[0].length / 4 - 4410);
      },
    );
    assert(incoming, 'the held incoming decoder has a cancellation signal');
    const removing = c.remove(entries[1].id);
    await timelineUntil(
      'B lease revoked during the head wait',
      () => incoming!.aborted,
    );
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
