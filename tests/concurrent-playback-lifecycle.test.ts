import { assert, assertEquals } from '@std/assert';
import {
  concurrentFixture,
  exact,
  until,
} from './helpers/concurrent-playback.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';

function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `concurrent HTTP: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}

test('both fresh resumable players restore independent nonzero scheduled origins', async () => {
  const ready = Promise.withResolvers<void>();
  const f = await concurrentFixture(undefined, {
    beforeRecordReply: () => ready.promise,
  });
  try {
    await f.initialize();
    await f.restart(async (store) => {
      await store.players.saveChanges({
        players: [1, 2].map((id) => ({
          playerId: id,
          commandedAtMs: Date.now() - id * 1000,
          state: {
            state: 'play',
            currentIndex: 0,
            positionMs: id * 100,
            repeat: 'off' as const,
            consume: false,
            shuffle: false,
          },
        })),
      });
    });
    for (const id of [1, 2]) {
      const { player } = await f.server.call(`/players/${id}`);
      assertEquals(player.state, 'play');
      assertEquals(
        player.positionMs,
        id * 100,
        'hold the requested media origin before scheduled playout',
      );
    }
    ready.resolve();
    await until(() =>
      [1, 2].every((id) => f.players.get(id).playerView().state === 'stop')
    );
    for (const [i, r] of f.receivers.entries()) {
      const player = i === 2 ? 2 : 1;
      const trace = f.traces.find((t) => t.ports.has(r.port))!;
      exact(
        trace.audio.scheduledRealAudio(r.sessions[0], r.nowMs()),
        f.waves[player - 1].subarray(44 + player * 4410 * 4),
      );
    }
    await f.libraryProof();
  } finally {
    ready.resolve();
    await f.close();
  }
});

test('clear/delete/recreate and default changes never retarget B existing stream', async () => {
  const f = await concurrentFixture([44100 + 353, 44100 * 9 + 351]);
  try {
    await f.initialize();
    const reference = f.players.get(1).queueView().items[0].reference;
    await Promise.all(
      [1, 2].map((id) => f.server.call(`/players/${id}/play`, 'POST', {})),
    );
    await until(() =>
      f.receivers.every((r) => r.sessions[0]?.audioPackets > 0)
    );
    const peer = (await f.server.call('/players/2')).player;
    const session = f.receivers[2].sessions[0];
    await f.server.call('/players/2/default', 'POST', {});
    await f.server.call('/players/1/queue', 'DELETE');
    assertEquals(f.players.get(1).queueView().items, []);
    await f.server.call('/players/1', 'DELETE');
    const { player: created } = await f.server.call('/players', 'POST', {
      name: 'Home',
    });
    assert(created.id !== 1 && created.id !== 2);
    await f.server.call(`/players/${created.id}/speakers/1`, 'PUT', {});
    await f.server.call(`/players/${created.id}/queue/items`, 'POST', {
      references: [reference],
    });
    await f.server.call(`/players/${created.id}/play`, 'POST', {});
    const current = (await f.server.call('/players/2')).player;
    assertEquals(current.current.entryId, peer.current.entryId);
    assertEquals(current.state, 'play');
    assertEquals(f.receivers[2].sessions.length, 1);
    assertEquals([session.flushes, session.teardowns, session.closedAtMs], [
      0,
      0,
      null,
    ]);
    await until(() => f.players.get(created.id).playerView().state === 'stop');
    const recreated = f.traces.filter((t) => t.ports.has(f.receivers[0].port));
    assertEquals(
      recreated.length,
      2,
      'fresh native stream owner, never the deleted one',
    );
    assertEquals(f.receivers[0].sessions.length, 2);
    exact(
      recreated[1].audio.scheduledRealAudio(
        f.receivers[0].sessions[1],
        f.receivers[0].nowMs(),
      ),
      f.waves[0].subarray(44),
    );
    await until(() => f.players.get(2).playerView().state === 'stop');
    const trace = f.traces.find((t) => t.ports.has(f.receivers[2].port))!;
    exact(
      trace.audio.scheduledRealAudio(session, f.receivers[2].nowMs()),
      f.waves[1].subarray(44),
    );
    await f.libraryProof();
  } finally {
    await f.close();
  }
});

test('last-speaker loss pauses A at its independently scheduled bookmark without interrupting B', async () => {
  const f = await concurrentFixture([44100 * 7 + 353, 44100 * 8 + 351]);
  try {
    await f.initialize();
    await f.server.call('/players/1/speakers/2', 'DELETE');
    await Promise.all(
      [1, 2].map((id) => f.server.call(`/players/${id}/play`, 'POST', {})),
    );
    await until(() => f.players.get(1).playerView().itemProgressMs > 250);
    const receiver = f.receivers[0], session = receiver.sessions[0];
    const before = receiver.nowMs();
    await f.server.call('/players/1/speakers/1', 'DELETE');
    const after = receiver.nowMs();
    const { player } = await f.server.call('/players/1');
    assertEquals(player.state, 'pause');
    await f.persistence.drain();
    assertEquals(
      (await f.server.f.store.playback.loadPlayerState(1))!.positionMs,
      player.positionMs,
    );
    const uncertainty =
      renderScheduledAudio(session, receiver.nowMs()).clockUncertaintyMs ?? 0;
    const frames = (at: number) => {
      const replay = renderScheduledAudio(session, at);
      assertEquals(replay.issues, []);
      let real = 0;
      for (let i = 0; i < replay.pcm.length; i += 4) {
        if (replay.pcm.subarray(i, i + 4).some((v) => v !== 0)) real++;
      }
      return Math.floor(real * 1000 / 44100);
    };
    const low = frames(before - uncertainty),
      high = frames(after + uncertainty);
    assert(
      player.positionMs >= low && player.positionMs <= high,
      `bookmark ${player.positionMs} agrees with wire schedule ${low}..${high}`,
    );
    assertEquals((await f.server.call('/players/2')).player.state, 'play');
    await until(() => f.players.get(2).playerView().state === 'stop');
    const trace = f.traces.find((t) => t.ports.has(f.receivers[2].port))!;
    exact(
      trace.audio.scheduledRealAudio(
        f.receivers[2].sessions[0],
        f.receivers[2].nowMs(),
      ),
      f.waves[1].subarray(44),
    );
    await f.libraryProof();
  } finally {
    await f.close();
  }
});
