import { assert, assertEquals } from '@std/assert';
import {
  concurrentFixture,
  exact,
  until,
} from './helpers/concurrent-playback.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import type { FakeRaopSession } from './helpers/fake-raop.ts';
import { crossfadeReference } from './helpers/crossfade-proof.ts';
import { concatenate } from './helpers/timeline-proof.ts';

function finalFlushAfterTail(session: FakeRaopSession, now: number) {
  const replay = renderScheduledAudio(session, now);
  assertEquals(replay.issues, []);
  const real = replay.ranges.filter((r) => r.pcm.some((v) => v !== 0));
  assert(real.length > 0);
  const last = real.at(-1)!;
  let lastFrame = last.frames - 1;
  while (
    lastFrame >= 0 &&
    last.pcm.subarray(lastFrame * 4, lastFrame * 4 + 4).every((v) => v === 0)
  ) lastFrame--;
  const end = last.atMs + (lastFrame + 1) * 1000 / 44100;
  for (const event of session.wire) {
    if (event.kind === 'flush' || event.kind === 'teardown') {
      assert(
        event.atMs >= end,
        'cleanup follows the complete scheduled real tail',
      );
    }
  }
}

function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `concurrent HTTP: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

for (const restore of [false, true]) {
  test(`${restore ? 'cold restore' : 'simultaneous start'} A(two speakers) and B render independent complete scheduled PCM and metadata`, async () => {
    const f = await concurrentFixture();
    try {
      await f.initialize();
      if (restore) {
        // Persist resumable intentions without manufacturing a periodic-time winner.
        const now = Date.now();
        await f.restart(async (store) => {
          await store.players.saveChanges({
            players: [1, 2].map((id) => ({
              playerId: id,
              commandedAtMs: now - id * 1000,
              state: {
                state: 'play',
                currentIndex: 0,
                positionMs: 0,
                repeat: 'off' as const,
                consume: false,
                shuffle: false,
              },
            })),
          });
        });
      } else {
        await Promise.all(
          [1, 2].map((id) => f.server.call(`/players/${id}/play`, 'POST', {})),
        );
      }
      await until(() =>
        f.receivers.every((r) => r.sessions.some((s) => s.audioPackets > 0))
      );
      for (const id of [1, 2]) {
        const { player } = await f.server.call(`/players/${id}`);
        assertEquals(player.state, 'play');
        assert(player.current.song.id);
        assert(player.positionMs >= 0);
        assert(player.positionMs <= player.durationMs);
      }
      await until(() =>
        [1, 2].every((id) => f.players.get(id).playerView().state === 'stop')
      );
      for (const [i, r] of f.receivers.entries()) {
        assertEquals(r.sessions.length, 1);
        const trace = f.traces.find((t) => t.ports.has(r.port))!;
        assert(trace && trace.audio.epochs.length === 1);
        const expected = f.waves[i === 2 ? 1 : 0].subarray(44);
        exact(trace.audio.realAudio(r.sessions[0]), expected);
        exact(
          trace.audio.scheduledRealAudio(r.sessions[0], r.nowMs()),
          expected,
        );
        const metadata = r.sessions[0].parameters.filter((p) =>
          p.contentType === 'application/x-dmap-tagged'
        ).map((p) => new TextDecoder().decode(p.body));
        assert(
          metadata.some((text) =>
            text.includes(i === 2 ? 'Player B' : 'Player A')
          ),
        );
        assert(
          metadata.every((text) =>
            !text.includes(i === 2 ? 'Player A' : 'Player B')
          ),
        );
        finalFlushAfterTail(r.sessions[0], r.nowMs());
      }
      assertEquals(
        f.traces.length,
        2,
        'one native stream per fixed player, not receiver',
      );
      assert(f.traces[0].ports.size !== f.traces[1].ports.size);
      await f.libraryProof();
    } finally {
      await f.close();
    }
  });
}

test('saved A crossfade mixes only A while B keeps its independent gapless schedule', async () => {
  const f = await concurrentFixture();
  try {
    await f.initialize();
    const references = [1, 2].map((id) =>
      f.players.get(id).queueView().items[0].reference
    );
    await f.server.call('/players/1/queue/items', 'POST', {
      references: [references[1]],
    });
    await f.server.call('/players/2/queue/items', 'POST', {
      references: [references[0]],
    });
    await f.server.call('/players/1', 'PATCH', { crossfadeMs: 100 });
    await f.persistence.drain();
    assertEquals(
      (await f.server.f.store.players.list()).map((row) => row.crossfadeMs),
      [100, 0],
    );
    await f.server.call('/players/2/default', 'POST', {});
    await Promise.all(
      [1, 2].map((id) => f.server.call(`/players/${id}/play`, 'POST', {})),
    );
    await until(() =>
      [1, 2].every((id) => f.players.get(id).playerView().state === 'stop')
    );
    const parts = f.waves.map((wav) => wav.subarray(44));
    const expected = [
      crossfadeReference(parts, 4410).pcm,
      concatenate([parts[1], parts[0]]),
    ];
    for (const [i, receiver] of f.receivers.entries()) {
      assertEquals(receiver.sessions.length, 1);
      const trace = f.traces.find((t) => t.ports.has(receiver.port))!;
      exact(
        trace.audio.scheduledRealAudio(receiver.sessions[0], receiver.nowMs()),
        expected[i === 2 ? 1 : 0],
      );
    }
    assertEquals(f.traces.length, 2);
    assert(f.traces[0].native.id !== f.traces[1].native.id);
    await f.libraryProof();
  } finally {
    await f.close();
  }
});

test('A pause/seek/Stop/next/EOF/failure/volume/default commands cannot disturb B scheduled audio', async () => {
  const f = await concurrentFixture([44100 + 353, 44100 * 12 + 351]);
  try {
    await f.initialize();
    const a = f.players.get(1).queueView().items[0];
    await f.server.call('/players/1/queue/items', 'POST', {
      references: [a.reference],
    });
    await Promise.all(
      [1, 2].map((id) => f.server.call(`/players/${id}/play`, 'POST', {})),
    );
    await until(() => f.receivers[2].sessions[0]?.audioPackets > 0);
    const peer = (await f.server.call('/players/2')).player;
    const session = f.receivers[2].sessions[0];
    const volume = session.volumeParams.at(-1);
    for (
      const [path, method, body] of [
        ['/players/1/pause', 'POST', {}],
        ['/players/1/seek', 'POST', { positionMs: 100 }],
        ['/players/1/play', 'POST', {}],
        ['/players/1/stop', 'POST', {}],
        ['/players/1/play', 'POST', {}],
        ['/players/1/next', 'POST', {}],
        ['/players/1/volume', 'PUT', { volume: 32 }],
        ['/players/2/default', 'POST', {}],
      ] as const
    ) {
      await f.server.call(path, method, body);
      const current = (await f.server.call('/players/2')).player;
      assertEquals(current.current.entryId, peer.current.entryId);
      assertEquals(current.state, 'play');
      assert(current.positionMs >= peer.positionMs);
      assertEquals(f.receivers[2].sessions.length, 1);
      assertEquals([session.flushes, session.teardowns, session.closedAtMs], [
        0,
        0,
        null,
      ]);
      assertEquals(session.volumeParams.at(-1), volume);
    }
    await until(() => f.players.get(1).playerView().state === 'stop');
    assertEquals((await f.server.call('/players/2')).player.state, 'play');
    f.failSources.add('A.wav');
    await f.server.call('/players/1/play', 'POST', {});
    await until(() => f.players.get(1).playerView().state === 'pause');
    assertEquals((await f.server.call('/players/2')).player.state, 'play');
    await until(() => f.players.get(2).playerView().state === 'stop');
    const trace = f.traces.find((t) => t.ports.has(f.receivers[2].port))!;
    exact(
      trace.audio.scheduledRealAudio(session, f.receivers[2].nowMs()),
      f.waves[1].subarray(44),
    );
    finalFlushAfterTail(session, f.receivers[2].nowMs());
    assertEquals(f.receivers[2].sessions.length, 1);
    await f.libraryProof();
  } finally {
    await f.close();
  }
});
