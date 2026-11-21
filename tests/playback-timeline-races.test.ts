import { assert, assertEquals } from '@std/assert';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import {
  concatenate,
  timelineControl,
  timelineLibraryProof,
  timelinePcm,
  timelineUntil,
} from './helpers/timeline-proof.ts';

function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `timeline races: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

for (const departure of ['withdrawn', 'failed'] as const) {
  test(`sealed two-speaker source revises ${departure} peer without retiring the healthy tail`, async () => {
    const bytes = timelinePcm(88200 + 137);
    const f = await nativeHttpFixture({ pcm: bytes, receiverCount: 2 });
    try {
      const c = await timelineControl(f);
      await c.add();
      await c.command('play');
      await timelineUntil(
        'sealed input still scheduled',
        () =>
          !!f.key &&
          f.receivers.every((peer) =>
            (peer.sessions[0]?.audioPackets ?? 0) >= 50
          ),
      );
      const survivor = f.receivers[1].sessions[0];
      if (departure === 'withdrawn') {
        await f.own('/outputs/1', 'PUT', { selected: false });
      } else f.receivers[0].close();
      await timelineUntil(
        'healthy source drains naturally',
        () => f.playback.playerView().state === 'stop',
      );
      assertEquals(f.receivers[1].sessions.length, 1);
      assertEquals(survivor.flushes, 0);
      const final = f.completions.find((receipt) =>
        receipt.status === 'complete' && receipt.revision === 2n
      );
      assert(final, 'core explicitly revised the captured barrier');
      assertEquals(
        final.attachments.map((a) => [a.outcome, a.excluded]).sort(),
        [[departure, true], ['complete', false]].sort(),
      );
      assertEquals(f.audio.realAudio(survivor), bytes);
      assertEquals(
        f.audio.scheduledRealAudio(survivor, f.receivers[1].nowMs()),
        bytes,
      );
      await timelineLibraryProof();
    } finally {
      await f.close();
    }
  });
}

test('failed speculative catalog decoder preserves A then pauses B under existing content policy', async () => {
  const parts = [
    timelinePcm(44100 + 137),
    timelinePcm(44100, 2),
    timelinePcm(44100 + 73, 3),
  ];
  let failed = false;
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: parts.slice(1),
    crossfadeMs: () => 100,
    beforeDecode(path) {
      if (path.endsWith('next-0.wav')) {
        failed = true;
        return Promise.reject(new Error('B decoder unavailable'));
      }
      return Promise.resolve();
    },
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.modes({ consume: true });
    await c.command('play');
    const entries = f.playback.queueView().items;
    const a = f.playback.queueView().items[0].id;
    await timelineUntil('speculative decode failed', () => failed);
    assertEquals((await c.current()).current.entryId, a);
    assertEquals(f.playback.queueView().items.length, 3);
    await timelineUntil(
      'due catalog failure pauses without native quarantine',
      () => f.playback.playerView().state === 'pause',
    );
    assertEquals(
      f.playback.queueView().items.map((entry) => entry.id),
      entries.slice(1).map((entry) => entry.id),
    );
    assertEquals((await c.current()).current.entryId, entries[1].id);
    assertEquals((await c.current()).positionMs, 0);
    assertEquals(f.audio.realAudio(f.receiver.sessions[0]), parts[0]);
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      parts[0],
    );
    await timelineUntil(
      'source-less native reset acknowledged',
      () => f.cancelAcks.length > 0,
    );
    assertEquals(f.cancelAcks.length, 1);
    await timelineLibraryProof();
  } finally {
    await f.close();
  }
});

test('late join has explicit suffix coverage and cannot enlarge an already sealed cohort', async () => {
  const bytes = timelinePcm(88200 + 137);
  const f = await nativeHttpFixture({
    pcm: bytes,
    receiverCount: 2,
    receiverSelection: [true, false],
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil(
      'original seal and packet coverage',
      () => !!f.key && (f.receiver.sessions[0]?.audioPackets ?? 0) >= 50,
    );
    await timelineUntil(
      'a real prefix is already presented before the suffix-only join',
      () => f.playback.playerView().itemProgressMs > 0,
    );
    await f.own('/outputs/2', 'PUT', { selected: true });
    await timelineUntil(
      'late peer renders a suffix',
      () => (f.receivers[1].sessions[0]?.audioPackets ?? 0) > 10,
    );
    await timelineUntil(
      'original real tail completes',
      () => f.playback.playerView().state === 'stop',
    );
    const completed = f.completions.find((receipt) =>
      receipt.status === 'complete'
    );
    assertEquals(completed?.required, 1n);
    assertEquals(completed?.attachments.length, 1);
    assertEquals(f.audio.realAudio(f.receiver.sessions[0]), bytes);
    const first = f.receiver.sessions[0].wire.find((event) =>
      event.kind === 'record'
    );
    const joined = f.receivers[1].sessions[0];
    const second = joined.wire.find((event) => event.kind === 'record');
    assert(first?.kind === 'record' && second?.kind === 'record');
    const offset = (Number(/rtptime=(\d+)/.exec(second.rtpInfo)![1]) -
      Number(/rtptime=(\d+)/.exec(first.rtpInfo)![1]) + 2 ** 32) % 2 ** 32;
    assert(offset > 0 && offset < bytes.length / 4);
    const replay = renderScheduledAudio(joined, f.receivers[1].nowMs());
    assertEquals(replay.issues, []);
    const suffix = bytes.subarray(offset * 4);
    assertEquals(replay.pcm.subarray(0, suffix.length), suffix);
    assertEquals(f.receivers[0].sessions.length, 1);
    await timelineLibraryProof();
  } finally {
    await f.close();
  }
});

for (
  const phase of [
    'preparation',
    'decoder',
    'append',
    'receipt',
    'accepted',
  ] as const
) {
  test(`remove speculative B during ${phase} never renders or publishes B`, async () => {
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    let armed = false, blocked = false, firstSource: bigint | undefined;
    const accepted = new Set<bigint>();
    const parts = [
      timelinePcm(88200 + 137),
      timelinePcm(44100 + 19, 2),
      timelinePcm(44100 + 73, 3),
    ];
    const f = await nativeHttpFixture({
      pcm: parts[0],
      additionalPcm: parts.slice(1),
      ...(phase === 'preparation' ? { web: 'finite' as const } : {}),
      async resolveSource(reference, resolve) {
        if (
          armed && phase === 'preparation' && reference.kind === 'station' &&
          reference.id === 'B' && !blocked
        ) {
          blocked = true;
          entered.resolve();
          await held.promise;
        }
        return await resolve();
      },
      async beforeDecode(path) {
        if (phase === 'decoder' && path.endsWith('next-0.wav') && !blocked) {
          blocked = true;
          entered.resolve();
          await held.promise;
        }
      },
      async append(request, append) {
        firstSource ??= request.source;
        if (request.source !== firstSource && !blocked && phase === 'append') {
          blocked = true;
          entered.resolve();
          await held.promise;
        }
        const result = await append(request);
        if (result.acceptedFrames) accepted.add(request.source);
        if (request.source !== firstSource && !blocked && phase === 'receipt') {
          blocked = true;
          entered.resolve();
          await held.promise;
        }
        return result;
      },
    });
    const published: number[] = [];
    const unsubscribe = f.fixture.notify!.subscribe(() => {
      const id = f.playback.playerView().current?.id;
      if (id !== undefined) published.push(id);
    });
    try {
      const c = await timelineControl(f);
      if (phase === 'preparation') {
        const added = await f.fixture.json(
          '/api/v1/players/1/queue/items',
          'POST',
          {
            references: [
              { kind: 'song', id: f.songIds[0] },
              { kind: 'station', id: 'B' },
              { kind: 'song', id: f.songIds[2] },
            ],
          },
          c.credential,
        );
        assertEquals(added.status, 200, await added.text());
      } else await c.add();
      const entries = f.playback.queueView().items;
      armed = true;
      await c.command('play');
      if (phase === 'accepted') {
        await timelineUntil('B accepted', () => accepted.size >= 2);
      } else await timelineUntil(`${phase} barrier entered`, () => blocked);
      const previous = f.playback.playerView().generation;
      const removal = c.remove(entries[1].id);
      await timelineUntil(
        'B removal published',
        () => !f.playback.queueView().items.some((e) => e.id === entries[1].id),
      );
      held.resolve();
      await removal;
      const reset = ['append', 'receipt', 'accepted'].includes(phase);
      assertEquals(
        f.playback.playerView().generation > previous,
        reset,
        'only possible accepted input requires a discontinuity',
      );
      await timelineUntil(
        'final tail and stop',
        () => f.playback.playerView().state === 'stop',
      );
      assertEquals(published.includes(entries[1].id), false);
      const session = f.receiver.sessions[0];
      assertEquals(session.flushes, reset ? 1 : 0);
      const expected = concatenate([parts[0], parts[2]]);
      assertEquals(f.audio.realAudio(session, reset ? 1 : 0), expected);
      assertEquals(
        f.audio.scheduledRealAudio(session, f.receiver.nowMs(), reset ? 1 : 0),
        expected,
      );
      const replay = renderScheduledAudio(session, f.receiver.nowMs());
      assertEquals(replay.issues, []);
      assertEquals(replay.pcm.subarray(0, expected.length), expected);
      await timelineLibraryProof();
    } finally {
      held.resolve();
      unsubscribe();
      await f.close();
    }
  });
}

for (
  const edit of [
    'move',
    'consume',
    'repeat',
    'clear',
    'unrelated-append',
  ] as const
) {
  test(`accepted future reconciles ${edit} through HTTP`, async () => {
    const accepted = new Set<bigint>();
    const parts = [
      timelinePcm(88200 + 137),
      timelinePcm(44100 + 19, 2),
      timelinePcm(44100 + 73, 3),
    ];
    const f = await nativeHttpFixture({
      pcm: parts[0],
      additionalPcm: parts.slice(1),
      async append(request, append) {
        const result = await append(request);
        if (result.acceptedFrames) accepted.add(request.source);
        return result;
      },
    });
    try {
      const c = await timelineControl(f);
      await c.add();
      const entries = f.playback.queueView().items;
      await c.command('play');
      await timelineUntil('future accepted', () => accepted.size >= 2);
      const generation = f.playback.playerView().generation;
      if (edit === 'move') await c.move(entries[1].id, 2);
      if (edit === 'consume') await c.modes({ consume: true });
      if (edit === 'repeat') await c.modes({ repeat: 'single' });
      if (edit === 'clear') await c.remove();
      if (edit === 'unrelated-append') await c.add([f.songIds[2]]);
      if (edit === 'clear') {
        assertEquals(f.playback.queueView().items, []);
        assertEquals((await c.current()).state, 'stop');
      } else {
        assertEquals(
          f.playback.playerView().generation === generation,
          edit === 'unrelated-append',
        );
        if (edit === 'repeat') {
          await timelineUntil(
            'A repeat published',
            () =>
              f.audio.epochs.some((e) =>
                e.completedThrough >= BigInt(parts[0].length / 4)
              ),
          );
          assertEquals((await c.current()).current.entryId, entries[0].id);
          assertEquals(
            f.audio.realAudio(f.receiver.sessions[0], 1, true),
            parts[0],
          );
        } else {
          await timelineUntil(
            'edited queue drained',
            () => f.playback.playerView().state === 'stop',
          );
          const ordered = edit === 'move'
            ? [parts[0], parts[2], parts[1]]
            : edit === 'unrelated-append'
            ? [...parts, parts[2]]
            : parts;
          const expected = concatenate(ordered),
            first = edit === 'unrelated-append' ? 0 : 1;
          assertEquals(
            f.audio.realAudio(f.receiver.sessions[0], first),
            expected,
          );
          assertEquals(
            f.audio.scheduledRealAudio(
              f.receiver.sessions[0],
              f.receiver.nowMs(),
              first,
            ),
            expected,
          );
          if (edit === 'consume') {
            assertEquals(f.playback.queueView().items, []);
          }
        }
      }
      await timelineLibraryProof();
    } finally {
      await f.close();
    }
  });
}

test('append after a prefetched exhaustion resumes the same epoch without dropping A tail', async () => {
  const held = Promise.withResolvers<void>();
  const parts = [timelinePcm(44100 + 137), timelinePcm(44100 + 19, 2)];
  let entered = false;
  const f = await nativeHttpFixture({
    pcm: parts[0],
    additionalPcm: [parts[1]],
    afterFirstChunk: held.promise,
    async append(request, append) {
      const result = await append(request);
      if (result.acceptedFrames) entered = true;
      return result;
    },
  });
  try {
    const c = await timelineControl(f);
    await c.add([f.songIds[0]]);
    await c.command('play');
    await timelineUntil('A prefix accepted', () => entered);
    await c.add([f.songIds[1]]);
    held.resolve();
    await timelineUntil(
      'both sources drained',
      () => f.playback.playerView().state === 'stop',
    );
    assertEquals(f.receiver.sessions.length, 1);
    assertEquals(f.receiver.sessions[0].flushes, 0);
    assertEquals(f.audio.realAudio(f.receiver.sessions[0]), concatenate(parts));
    assertEquals(
      f.audio.scheduledRealAudio(f.receiver.sessions[0], f.receiver.nowMs()),
      concatenate(parts),
    );
    await timelineLibraryProof();
  } finally {
    held.resolve();
    await f.close();
  }
});
