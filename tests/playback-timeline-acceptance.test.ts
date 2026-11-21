// One-player acceptance: cold non-loopback plain HTTP -> real decoder -> core
// timeline -> shipping FFI -> scheduled UDP/ALAC receivers. Real-source regions
// are exact; every extra transport frame has an explicit zero silence range.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { nativeHttpFixture } from './helpers/playback-native-http.ts';
import { concurrentFixture, exact } from './helpers/concurrent-playback.ts';
import { renderScheduledAudio } from './helpers/raop-scheduled-consumer.ts';
import {
  concatenate,
  timelineControl,
  timelineLibraryProof,
  timelinePcm,
  timelineUntil,
} from './helpers/timeline-proof.ts';
import type { FakeRaopSession } from './helpers/fake-raop.ts';

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name: `timeline acceptance: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn,
  });
}
function silenceAfter(session: FakeRaopSession, nowMs: number, real: number) {
  const replay = renderScheduledAudio(session, nowMs);
  assertEquals(replay.issues, []);
  exact(
    replay.pcm.subarray(real),
    new Uint8Array(replay.pcm.length - real),
  );
  return replay;
}

for (const strategy of ['melofon', 'owntone', 'audiostation'] as const) {
  test(`${strategy}: two speakers render read-ahead succession and final tail exactly`, async () => {
    const parts = [
      timelinePcm(353),
      timelinePcm(351, 2),
      timelinePcm(44100 + 137, 3),
    ];
    const f = await nativeHttpFixture({
      pcm: parts[0],
      additionalPcm: parts.slice(1),
      receiverCount: 2,
    });
    try {
      for (const output of f.outputs.list()) {
        f.outputs.update(output.id, { connectionStrategy: strategy });
      }
      const c = await timelineControl(f);
      await c.add();
      await c.modes({ consume: true });
      const first = f.playback.queueView().items[0].id;
      await c.command('play');
      await timelineUntil(
        'every source accepted and sealed ahead of playout',
        () => f.key?.target === BigInt(parts[2].length / 4),
      );
      assertEquals(
        (await c.current()).current.entryId,
        first,
        'read-ahead never publishes the read cursor as current',
      );
      assertEquals(f.playback.queueView().items.length, 3);
      await timelineUntil(
        'natural terminal stop',
        () => f.playback.playerView().state === 'stop',
      );
      const expected = concatenate(parts);
      assertEquals(f.audio.epochs.length, 1, 'one continuous epoch');
      let end = 0n;
      for (const range of f.audio.epochs[0].ranges) {
        if (range.kind !== 'real') continue;
        assertEquals(range.transportStart, end, 'no inter-item silence');
        end += range.frames;
      }
      assertEquals(end, BigInt(expected.length / 4));
      for (const peer of f.receivers) {
        assertEquals(peer.sessions.length, 1, 'one receiver session');
        const session = peer.sessions[0];
        assertEquals(session.flushes, 0, 'natural boundaries never FLUSH');
        exact(f.audio.realAudio(session), expected);
        exact(f.audio.scheduledRealAudio(session, peer.nowMs()), expected);
        const replay = silenceAfter(session, peer.nowMs(), expected.length);
        exact(replay.pcm.subarray(0, expected.length), expected);
      }
      assertEquals(f.playback.queueView().items, [], 'each item consumed');
      assertEquals((await c.current()).state, 'stop');
      await timelineLibraryProof();
    } finally {
      await f.close();
    }
  });
}

test('short finite web speech keeps every real frame through succession and final stop', async () => {
  const bytes = timelinePcm(4410 + 353);
  const f = await nativeHttpFixture({
    pcm: bytes,
    web: 'finite',
    receiverCount: 2,
  });
  try {
    const c = await timelineControl(f);
    await f.play(false);
    await f.play(false);
    const entries = f.playback.queueView().items;
    assertEquals(entries.length, 2);
    assert(
      entries.every((entry) =>
        entry.facts.kind === 'web' && entry.facts.mode === 'finite'
      ),
    );
    await c.command('play');
    await timelineUntil(
      'both finite web sources rendered',
      () => f.playback.playerView().state === 'stop',
    );
    const expected = concatenate([bytes, bytes]);
    for (const peer of f.receivers) {
      assertEquals(peer.sessions.length, 1);
      assertEquals(peer.sessions[0].flushes, 0);
      exact(f.audio.realAudio(peer.sessions[0]), expected);
      exact(
        f.audio.scheduledRealAudio(peer.sessions[0], peer.nowMs()),
        expected,
      );
      silenceAfter(peer.sessions[0], peer.nowMs(), expected.length);
    }
    await timelineLibraryProof();
  } finally {
    await f.close();
  }
});

// The interposer holds the shipping library's real pacer timer, so accepted
// and sealed EOF stays unemitted. It is loaded only into this child process.
async function pacerChild(name: string) {
  const directory = await Deno.makeTempDir({ prefix: 'timeline-acceptance-' });
  try {
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
        `--filter=${name}`,
        new URL(import.meta.url).pathname,
      ],
      env: {
        LD_PRELOAD: interposer,
        MELOFON_ACCEPTANCE_CHILD: name,
        RAOP_PROGRESS_HOLD: `${directory}/hold`,
      },
    }).output();
    const stdout = new TextDecoder().decode(child.stdout);
    assertEquals(
      child.code,
      0,
      stdout + new TextDecoder().decode(child.stderr),
    );
    assert(/1 passed.*0 failed/.test(stdout));
    for (const line of stdout.split('\n')) {
      if (line.startsWith('timeline native library:')) console.log(line);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

for (const action of ['release', 'cancel'] as const) {
  const name = `held native emission barrier then ${action}`;
  test(name, async () => {
    if (Deno.env.get('MELOFON_ACCEPTANCE_CHILD') !== name) {
      return await pacerChild(name);
    }
    const hold = Deno.env.get('RAOP_PROGRESS_HOLD')!;
    await Deno.writeTextFile(hold, 'hold the real native pacer');
    const parts = [timelinePcm(353), timelinePcm(351, 2)];
    const f = await nativeHttpFixture({
      pcm: parts[0],
      additionalPcm: [parts[1]],
      receiverCount: 2,
    });
    try {
      const c = await timelineControl(f);
      await c.add();
      await c.modes({ consume: true });
      const ids = f.playback.queueView().items.map((entry) => entry.id);
      await c.command('play');
      await timelineUntil(
        'both EOFs accepted and sealed',
        () => f.key?.target === 351n,
      );
      await sleep(1200);
      const held = await c.current();
      assertEquals(held.current.entryId, ids[0]);
      assertEquals(held.positionMs, 0, 'no position without emission');
      assertEquals(f.playback.queueView().items.map((e) => e.id), ids);
      assertEquals(f.ackStates, [], 'no completion before emission');
      assertEquals(
        (await f.native.source(f.key!.epoch, f.key!.source))!.fedFrames,
        0n,
      );
      assertEquals((await f.native.pollCompletion(f.key!))!.status, 'pending');
      for (const peer of f.receivers) {
        assertEquals(peer.sessions[0].audioPayloads.length, 0);
        assertEquals(peer.sessions[0].closedAtMs, null);
        assertEquals(peer.sessions[0].flushes, 0);
      }
      if (action === 'cancel') {
        await c.command('stop');
        await timelineUntil(
          'canceled epoch reset',
          () => f.cancelAcks.length === 1,
        );
        assertEquals(
          f.playback.queueView().items.map((e) => e.id),
          ids,
          'deliberate cancellation never consumes',
        );
        assertEquals(f.completions.filter((r) => r.status === 'complete'), []);
        await Deno.remove(hold);
        await sleep(600);
        for (const peer of f.receivers) {
          assertEquals(
            peer.sessions.flatMap((s) => s.audioPayloads).length,
            0,
            'canceled unemitted input never reaches a receiver',
          );
        }
        assertEquals(f.audio.epochs, []);
        assertEquals((await c.current()).current.entryId, ids[0]);
        assertEquals((await c.current()).positionMs, 0);
      } else {
        await Deno.remove(hold);
        await timelineUntil(
          'scheduled terminal transition after emission',
          () => f.playback.playerView().state === 'stop',
        );
        const expected = concatenate(parts);
        for (const peer of f.receivers) {
          exact(f.audio.realAudio(peer.sessions[0]), expected);
          exact(
            f.audio.scheduledRealAudio(peer.sessions[0], peer.nowMs()),
            expected,
          );
          silenceAfter(peer.sessions[0], peer.nowMs(), expected.length);
        }
        assertEquals(f.playback.queueView().items, []);
      }
      await timelineLibraryProof();
    } finally {
      await Deno.remove(hold).catch(() => {});
      await f.close();
    }
  });
}

test('held Pause keeps its admission bookmark and resume renders the exact suffix', async () => {
  const flush = Promise.withResolvers<void>();
  const bytes = timelinePcm(44100 * 3 + 137);
  const f = await nativeHttpFixture({
    pcm: bytes,
    persist: true,
    receiver: { beforeFlushReply: () => flush.promise },
  });
  try {
    const c = await timelineControl(f);
    await c.add();
    await c.command('play');
    await timelineUntil(
      'scheduled prefix before Pause',
      () => f.playback.playerView().itemProgressMs > 100,
    );
    await c.command('pause');
    await timelineUntil(
      'FLUSH held after cutoff capture',
      () =>
        f.receiver.sessions[0].flushes === 1 &&
        f.capturedCutoffs.length === 1,
    );
    const bookmark = Math.floor(
      Number(f.capturedCutoffs[0].progress!.sourceFrames) * 1000 / 44100,
    );
    await sleep(350);
    assertEquals((await c.current()).positionMs, bookmark);
    assertEquals((await f.saved())!.positionMs, bookmark);
    assertEquals(f.cancelAcks, [], 'readiness is still held');
    flush.resolve();
    await timelineUntil('Pause reset ready', () => f.cancelAcks.length === 1);
    await c.command('play');
    await timelineUntil(
      'resume opens at bookmark',
      () => f.origins.length === 2,
    );
    assertEquals(f.origins[1], bookmark);
    await timelineUntil(
      'resumed suffix drains',
      () => f.playback.playerView().state === 'stop',
    );
    const suffix = bytes.subarray(Math.round(bookmark * 44100 / 1000) * 4);
    const session = f.receiver.sessions.at(-1)!;
    const epoch = f.receiver.sessions.length === 1 ? 1 : 0;
    assertEquals(f.audio.epochs.length, 1, 'only the resumed epoch completes');
    exact(f.audio.realAudio(session, epoch), suffix);
    exact(
      f.audio.scheduledRealAudio(session, f.receiver.nowMs(), epoch),
      suffix,
    );
    await timelineLibraryProof();
  } finally {
    flush.resolve();
    await f.close();
  }
});

async function peerContinues(
  f: Awaited<ReturnType<typeof concurrentFixture>>,
  session: FakeRaopSession,
) {
  const packets = session.audioPackets;
  await timelineUntil(
    'disjoint peer keeps emitting',
    () => session.audioPackets >= packets + 8,
  );
  assertEquals(f.players.get(2).playerView().state, 'play');
  assertEquals(f.receivers[2].sessions.length, 1);
  assert(f.receivers[2].sessions[0] === session);
  assertEquals([session.flushes, session.teardowns, session.closedAtMs], [
    0,
    0,
    null,
  ]);
}

test('per-player stream retention through Pause and natural retirement leaves a disjoint peer independent', async () => {
  const close = Promise.withResolvers<void>();
  let entered = false;
  const f = await concurrentFixture([44100 + 353, 44100 * 10 + 351], {
    async closeStream(release) {
      entered = true;
      await close.promise;
      await release();
    },
  });
  try {
    await f.initialize();
    await f.server.call('/players/1/play', 'POST', {});
    await timelineUntil(
      'A plays on both speakers',
      () =>
        f.receivers.slice(0, 2).every((r) =>
          (r.sessions[0]?.audioPackets ?? 0) >= 20
        ),
    );
    await f.server.call('/players/2/play', 'POST', {});
    await timelineUntil(
      'B emits while A owns its stream',
      () => (f.receivers[2].sessions[0]?.audioPackets ?? 0) >= 20,
    );
    const session = f.receivers[2].sessions[0];
    const peer = f.traces.find((t) => t.ports.has(f.receivers[2].port))!;
    assertEquals(f.traces.length, 2);
    assert(f.traces[0].native.id !== peer.native.id);
    await f.server.call('/players/1/pause', 'POST', {});
    await peerContinues(f, session);
    await f.server.call('/players/1/play', 'POST', {});
    await timelineUntil(
      'natural end with native retirement held',
      () => entered && f.players.get(1).playerView().state === 'stop',
    );
    assertEquals(f.traces.length, 2, 'retirement retains the existing owners');
    await timelineUntil(
      'B completes while A native retirement remains held',
      () => f.players.get(2).playerView().state === 'stop',
    );
    exact(
      peer.audio.scheduledRealAudio(session, f.receivers[2].nowMs()),
      f.waves[1].subarray(44),
    );
    assertEquals([session.flushes, session.teardowns, session.closedAtMs], [
      0,
      0,
      null,
    ]);
    close.resolve();
    await f.libraryProof();
  } finally {
    close.resolve();
    await f.close();
  }
});

test('failed native release quarantines its owner without blocking a disjoint player', async () => {
  let raw: (() => Promise<void>) | undefined;
  const f = await concurrentFixture([44100 + 353, 44100 * 8 + 351], {
    closeStream(release) {
      if (raw) return release();
      raw = release;
      return Promise.reject(new Error('acceptance native free failure'));
    },
  });
  let failed = false;
  try {
    await f.initialize();
    await f.server.call('/players/1/play', 'POST', {});
    await timelineUntil(
      'scheduled prefix',
      () => f.players.get(1).playerView().itemProgressMs > 100,
    );
    await f.server.call('/players/1/stop', 'POST', {});
    await timelineUntil('release attempted', () => raw !== undefined);
    await f.server.call('/players/2/play', 'POST', {});
    await timelineUntil(
      'B emits despite A release failure',
      () => (f.receivers[2].sessions[0]?.audioPackets ?? 0) >= 20,
    );
    const session = f.receivers[2].sessions[0];
    const peer = f.traces.find((t) => t.ports.has(f.receivers[2].port))!;
    await assertRejects(
      () => f.boots.get(1)!.close(),
      AggregateError,
      'stream release failed',
    );
    await sleep(300);
    await peerContinues(f, session);
    assertEquals(f.players.get(1).playerView().state, 'pause');
    assertEquals(f.traces.length, 2, 'quarantined owner is never replaced');
    assertEquals(f.receivers.slice(0, 2).map((r) => r.sessions.length), [1, 1]);
    assertEquals(
      f.traces[0].audio.epochs,
      [],
      'canceled partial source is never a completion',
    );
    await timelineUntil(
      'B completes despite A quarantine',
      () => f.players.get(2).playerView().state === 'stop',
    );
    exact(
      peer.audio.scheduledRealAudio(session, f.receivers[2].nowMs()),
      f.waves[1].subarray(44),
    );
    await f.libraryProof();
    failed = true;
    await assertRejects(() => f.close(), AggregateError);
  } finally {
    // The seam refused native free; free the raw object without resetting the
    // quarantined public owner.
    await raw?.();
    if (!failed) await f.close().catch(() => {});
  }
});
