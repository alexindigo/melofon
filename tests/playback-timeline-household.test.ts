import { assert, assertEquals } from '@std/assert';
import {
  concurrentFixture,
  exact,
  until,
} from './helpers/concurrent-playback.ts';
import { concatenate } from './helpers/timeline-proof.ts';

function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `timeline household: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
test('transfer a sealed cohort member to an idle player preserves the healthy source', async () => {
  const f = await concurrentFixture();
  try {
    await f.initialize();
    await f.server.call('/players/1/play', 'POST', {});
    await until(() =>
      f.receivers.slice(0, 2).every((r) =>
        (r.sessions[0]?.audioPackets ?? 0) >= 50
      )
    );
    const a = f.traces.find((t) => t.ports.has(f.receivers[1].port))!;
    const survivor = f.receivers[1].sessions[0];
    await f.server.call('/players/2/speakers/1', 'PUT', {});
    await until(() =>
      f.players.get(1).playerView().state === 'stop' ||
      survivor.closedAtMs !== null
    );
    assertEquals(a.audio.epochs.length, 1);
    exact(
      a.audio.scheduledRealAudio(survivor, f.receivers[1].nowMs()),
      f.waves[0].subarray(44),
    );
    assertEquals(f.players.get(1).playerView().state, 'stop');
    assertEquals(f.players.get(2).playerView().state, 'stop');
    await f.libraryProof();
  } finally {
    await f.close();
  }
});

for (const mode of ['add', 'replace']) {
  test(`HTTP queue copy ${mode} reconciles accepted future audio`, async () => {
    const f = await concurrentFixture();
    try {
      await f.initialize();
      const first = f.players.get(1).queueCopyView().items[0];
      await f.players.get(1).queueAddSources([first]);
      await f.server.call('/players/1/play', 'POST', {});
      await until(() =>
        f.players.get(1).sourcePlanView().reading !== null ||
        (f.receivers[0].sessions[0]?.audioPackets ?? 0) >= 100
      );
      await f.server.call(`/players/2/queue/copy/${mode}`, 'POST', {
        targetPlayerId: 1,
        startPlaying: mode === 'replace',
      });
      await until(() => f.players.get(1).playerView().state === 'stop');
      const a = mode === 'replace'
        ? f.traces.at(-1)!
        : f.traces.find((t) => t.ports.has(f.receivers[1].port))!;
      const expected = mode === 'replace'
        ? f.waves[1].subarray(44)
        : concatenate([
          f.waves[0].subarray(44),
          f.waves[0].subarray(44),
          f.waves[1].subarray(44),
        ]);
      const session = mode === 'replace'
        ? f.receivers[1].sessions.at(-1)!
        : f.receivers[1].sessions[0];
      exact(a.audio.realAudio(session), expected);
      exact(
        a.audio.scheduledRealAudio(
          session,
          f.receivers[1].nowMs(),
          0,
        ),
        expected,
      );
      await f.libraryProof();
    } finally {
      await f.close();
    }
  });
}

test('delete and recreate cannot publish the sealed old incarnation into the replacement', async () => {
  const f = await concurrentFixture();
  try {
    await f.initialize();
    await f.server.call('/players/1/play', 'POST', {});
    await until(() => (f.receivers[0].sessions[0]?.audioPackets ?? 0) >= 50);
    await f.server.call('/players/2/default', 'POST', {});
    await f.server.call('/players/1', 'DELETE');
    assert(f.receivers[0].sessions[0].closedAtMs !== null);
    const created = await f.server.call('/players', 'POST', {
      name: 'Replacement',
    });
    const replacement = created.player.id;
    assert(replacement > 2);
    await f.server.call(`/players/${replacement}/speakers/1`, 'PUT', {});
    await f.server.call('/players/2/queue/copy/replace', 'POST', {
      targetPlayerId: replacement,
      startPlaying: true,
    });
    await until(() => f.players.get(replacement).playerView().state === 'stop');
    const trace = f.traces.at(-1)!;
    exact(
      trace.audio.realAudio(f.receivers[0].sessions[1]),
      f.waves[1].subarray(44),
    );
    exact(
      trace.audio.scheduledRealAudio(
        f.receivers[0].sessions[1],
        f.receivers[0].nowMs(),
      ),
      f.waves[1].subarray(44),
    );
    assertEquals(f.players.get(2).playerView().state, 'stop');
    await f.libraryProof();
  } finally {
    await f.close();
  }
});
