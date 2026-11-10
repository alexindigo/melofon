import { assert, assertEquals, assertRejects } from '@std/assert';
import { createOutputs, createPlayer } from '../src/player.ts';
import { playerOutputs } from '../src/player-outputs.ts';
import { createPlayback } from '../src/playback.ts';
import { PlaybackError } from '../src/playback-errors.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import type { HelperEventFn } from '../src/boots/airplay-profile.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createNotify } from '../src/notify.ts';
import { createMedia } from '../src/media.ts';
import { openStore } from '../src/store/index.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { scanLibrary } from '../src/scan.ts';
import { catalogMedia, type QueueMedia } from '../src/queue-source.ts';
import { restored } from './helpers/prepared.ts';
import { receiver, sleep, until } from './helpers/speaker-consumer.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);
  return { promise, resolve };
}

/** Explicitly composed engine/boot consumers. Registry wiring is f04b. */
async function fixture(options: { eofGate?: Promise<void> } = {}) {
  const dir = await restored('playback-capacity', async (dir) => {
    const store = await openStore(dir);
    try {
      await createLibraries(store).add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(store);
    } finally {
      await store.close();
    }
  }, 'melofon-capacity-');
  const store = await openStore(dir), notify = createNotify();
  const library = createLibrary(store), nowPlaying = createNowPlaying(store);
  const songs = await library.listSongs({ offset: 0, size: 2 });
  const outputs = createOutputs({ notify });
  for (const id of [1, 2]) {
    outputs.register({
      id: String(id * 11),
      name: `Speaker ${id}`,
      type: 'AirPlay',
      host: '127.0.0.1',
      port: 7000 + id,
      volume: 80,
      selected: false,
      playerId: id,
    });
  }
  type Session = {
    event: HelperEventFn;
    port: number;
    bytes: number;
    closing: boolean;
    closed: boolean;
    closeGate?: Promise<void>;
    closeFails?: boolean;
  };
  const sessions: Session[] = [];
  const startGates: (Promise<void> | undefined)[] = [];
  const targetGates: (Promise<void> | undefined)[] = [];
  const resolveGates: (Promise<void> | undefined)[] = [];
  const mediaGates: (Promise<void> | undefined)[] = [];
  const idGates: (Promise<void> | undefined)[] = [];
  const failures: boolean[] = [], entered: string[][] = [[], []];
  const retry: (() => void)[][] = [[], []];
  const devices = createAirplayDevices({
    outputs,
    changed: () => notify.emit(['outputs'], undefined, 'all'),
    resolver: {
      resolve: (_host, port) => Promise.resolve(receiver(port! - 7000, port!)),
      close() {},
    },
    spawn(event) {
      const session: Session = {
        event,
        port: 0,
        bytes: 0,
        closing: false,
        closed: false,
      };
      sessions.push(session);
      return {
        transport: {
          send: () => Promise.resolve(),
          pcm(chunk) {
            session.bytes += chunk.length;
            return Promise.resolve();
          },
          async close() {
            session.closing = true;
            await session.closeGate;
            if (session.closeFails) throw new Error('Controlled close failure');
            session.closed = true;
          },
          cancelPcm() {},
          ownsSharedFeed: () => false,
        },
        async start(profile) {
          session.port = profile.port;
          await startGates[profile.port - 7001];
          event('state', 'connected');
        },
      };
    },
  });
  const speakers = createSpeakers({
    outputs,
    adapterView: devices.describe,
    prepare: devices.preparePlayback,
  });
  const capacities = [1, 2].map((id) =>
    devices.capacity.forPlayer(() => ({ id, name: `Player ${id}` }))
  );
  const times = [0, 0];
  const players = [1, 2].map((_, index) =>
    createPlayer({ monotonicNow: () => times[index] })
  );
  let nextId = 1;
  const playback = players.map((player, index) =>
    createPlayback({
      player,
      playerId: index + 1,
      capacity: capacities[index],
      outputs: playerOutputs(outputs, index + 1),
      library,
      nowPlaying,
      notify,
      cfg: {},
      targets: {
        hasPlaybackTarget: () => speakers.hasPlaybackTarget(index + 1),
        async preparePlayback(signal) {
          entered[index].push('target');
          await targetGates[index];
          if (failures[index]) {
            throw new PlaybackError(
              'target_unavailable',
              'Controlled preparation failure',
            );
          }
          await speakers.preparePlayback(signal, index + 1);
        },
      },
      async reserveQueueIds(count) {
        entered[index].push('ids');
        await idGates[index];
        const first = nextId;
        nextId += count;
        return first;
      },
      async resolveQueueReference(reference) {
        entered[index].push('resolve');
        await resolveGates[index];
        if (reference.kind === 'song') {
          const song = await library.getSong(reference.id);
          return song ? catalogMedia(song) : null;
        }
        return web;
      },
      async prepareQueueMedia(media) {
        entered[index].push('media');
        await mediaGates[index];
        return media;
      },
    })
  );
  for (const engine of playback) await engine.queueAdd(songs);
  const sourceEnds = [new Set<number>(), new Set<number>()];
  let eofEntered = false;
  const boots = playback.map((engine, index) => {
    const media = createMedia();
    return createAirplayBoot({
      playerId: index + 1,
      playback: {
        ...engine,
        reportSourceOutcome(source, outcome) {
          const accepted = engine.reportSourceOutcome(source, outcome);
          if (accepted && outcome === 'eof') {
            sourceEnds[index].add(source.entryId);
          }
          return accepted;
        },
      },
      capacity: capacities[index],
      outputs: playerOutputs(outputs, index + 1),
      devices,
      notify,
      media: options.eofGate
        ? {
          ...media,
          async decodePcm(path, opts) {
            const stream = await media.decodePcm(path, opts);
            if (!stream) return null;
            return (async function* () {
              for await (const chunk of stream) yield chunk;
              if (index === 0) {
                eofEntered = true;
                await options.eofGate;
              }
            })();
          },
        }
        : media,
      retryBackoffMs: [0, 0],
      retryTimer: {
        set(callback) {
          retry[index].push(callback);
          return { cancel() {} };
        },
      },
    });
  });
  const web: QueueMedia = {
    reference: { kind: 'url', url: 'http://melofon.home/test.wav' },
    facts: {
      kind: 'web',
      url: 'http://melofon.home/test.wav',
      title: null,
      artistName: null,
      durationMs: null,
      mode: 'unknown',
      seekable: false,
      streamTitle: null,
      streamUrl: null,
    },
  };
  return {
    playback,
    players,
    outputs,
    devices,
    capacities,
    boots,
    sessions,
    songs,
    web,
    targetGates,
    resolveGates,
    mediaGates,
    idGates,
    startGates,
    failures,
    entered,
    retry,
    times,
    sourceEnds,
    eofEntered: () => eofEntered,
    async close() {
      for (const engine of playback) await engine.close();
      await Promise.all(boots.map((boot) => boot.close()));
      devices.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function busy(command: () => unknown) {
  const error = await assertRejects(async () => {
    await command();
  }, PlaybackError);
  assertEquals(error.code, 'airplay_busy');
  assertEquals(error.owner, { id: 1, name: 'Player 1' });
  assertEquals(error.message, 'AirPlay is busy in Player 1');
}

Deno.test('capacity reserves before target preparation; simultaneous starts have one PCM winner', async () => {
  const f = await fixture(), held = deferred();
  try {
    f.targetGates[0] = held.promise;
    const start = f.playback[0].play();
    await busy(() => f.playback[1].play());
    assertEquals(f.entered[1].includes('target'), false);
    assertEquals(f.sessions.length, 0);
    held.resolve();
    await start;
    await until(() => f.sessions[0]?.bytes > 0);
    assertEquals(f.sessions.length, 1);
    assertEquals(f.sessions[0].port, 7001);
    assertEquals(f.playback[1].playerView().state, 'stop');
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('canceled preparation frees demand immediately and cannot publish late PCM', async () => {
  const f = await fixture(), held = deferred();
  try {
    f.targetGates[0] = held.promise;
    const start = f.playback[0].play();
    const canceled = assertRejects(
      async () => await start,
      PlaybackError,
      'cancelled',
    );
    f.playback[0].pause();
    await f.playback[1].play();
    await until(() => f.sessions[0]?.bytes > 0);
    held.resolve();
    await canceled;
    assertEquals(f.sessions.map((s) => s.port), [7002]);
    assertEquals(f.playback[0].playerView().state, 'stop');
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('failed preparation does not strand the stream reservation', async () => {
  const f = await fixture();
  try {
    f.failures[0] = true;
    await assertRejects(
      async () => await f.playback[0].play(),
      PlaybackError,
      'Controlled',
    );
    await f.playback[1].play();
    await until(() => f.sessions[0]?.bytes > 0);
    assertEquals(f.sessions[0].port, 7002);
  } finally {
    await f.close();
  }
});

for (const preparation of ['resolve', 'media', 'ids'] as const) {
  Deno.test(`add-and-play reserves before slow ${preparation} work and releases on cancellation`, async () => {
    const f = await fixture(), held = deferred();
    try {
      f[
        preparation === 'resolve'
          ? 'resolveGates'
          : preparation === 'media'
          ? 'mediaGates'
          : 'idGates'
      ][0] = held.promise;
      const start = preparation === 'ids'
        ? f.playback[0].queueAdd(f.songs, { play: true, clear: true })
        : preparation === 'media'
        ? f.playback[0].queueAddSources([f.web], { play: true, clear: true })
        : f.playback[0].queueAddReferences([{
          kind: 'song',
          id: f.songs[0].id,
        }], { play: true, clear: true });
      const canceled = assertRejects(async () => await start, PlaybackError);
      await until(() => f.entered[0].includes(preparation));
      await busy(() => f.playback[1].play());
      f.playback[0].stop();
      await f.playback[1].play();
      await until(() => f.sessions[0]?.bytes > 0);
      held.resolve();
      await canceled;
      assertEquals(
        f.playback[0].queueView().items.length,
        2,
        'refused/canceled additions do not clear the queue',
      );
      assertEquals(f.sessions.map((s) => s.port), [7002]);
    } finally {
      held.resolve();
      await f.close();
    }
  });
}

Deno.test('all explicit start paths use the same typed capacity boundary without mutation', async () => {
  const f = await fixture();
  try {
    await f.playback[0].play();
    await until(() => f.sessions[0]?.bytes > 0);
    const other = f.playback[1], queue = other.queueView();
    for (
      const command of [
        () => other.play(),
        () => other.toggle(),
        () => other.next(),
        () => other.previous(),
        () => other.seek({ positionMs: 10 }),
        () => other.queueAdd(f.songs, { play: true, clear: true }),
        () =>
          other.queueAddReferences([{ kind: 'song', id: f.songs[0].id }], {
            play: true,
          }),
        () =>
          other.restore({
            queue: queue.items,
            version: queue.version,
            nextId: 100,
            state: 'play',
            currentIndex: 0,
            positionMs: 0,
            repeat: 'off',
            shuffle: false,
            consume: false,
            queueChanged: false,
          }),
      ]
    ) {
      await busy(command);
      assertEquals(other.queueView(), queue);
      assertEquals(other.playerView().state, 'stop');
    }
    assertEquals(f.playback[0].playerView().state, 'play');
    assertEquals(f.sessions.length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('same-player next and seek retain ownership until actual close completes', async () => {
  const f = await fixture(), held = deferred();
  try {
    await f.playback[0].play();
    await until(() => f.sessions[0]?.bytes > 0);
    await f.playback[0].next();
    await until(() => f.sessions.some((s, i) => i > 0 && s.bytes > 0));
    await f.playback[0].seek({ positionMs: 10 });
    await until(() => f.sessions.filter((s) => s.bytes > 0).length >= 3);
    await f.playback[0].restart();
    await until(() => f.sessions.filter((s) => s.bytes > 0).length >= 4);
    const live = f.sessions.findLast((s) => !s.closed)!;
    live.closeGate = held.promise;
    f.playback[0].pause();
    await until(() => live.closing);
    await busy(() => f.playback[1].play());
    held.resolve();
    await until(() => live.closed);
    await f.playback[1].play();
    await until(() => f.sessions.some((s) => s.port === 7002 && s.bytes > 0));
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('canceled activation retains occupancy through real cleanup and sends no PCM', async () => {
  const f = await fixture(), start = deferred(), close = deferred();
  try {
    f.startGates[0] = start.promise;
    await f.playback[0].play();
    await until(() => f.sessions.length === 1);
    f.sessions[0].closeGate = close.promise;
    f.playback[0].pause();
    await until(() => f.sessions[0].closing);
    await busy(() => f.playback[1].play());
    start.resolve();
    await sleep(20);
    assertEquals(f.sessions[0].bytes, 0);
    close.resolve();
    await until(() => f.sessions[0].closed);
    await f.playback[1].play();
    await until(() => f.sessions.some((s) => s.port === 7002 && s.bytes > 0));
  } finally {
    start.resolve();
    close.resolve();
    await f.close();
  }
});

Deno.test('failed transport cleanup keeps shared-stream occupancy blocking other receivers', async () => {
  const f = await fixture();
  try {
    await f.playback[0].play();
    await until(() => f.sessions[0]?.bytes > 0);
    f.sessions[0].closeFails = true;
    f.playback[0].pause();
    await until(() =>
      f.devices.describe('11').session?.connection === 'failed'
    );
    await busy(() => f.playback[1].play());
    await f.boots[0].close();
    await busy(() => f.playback[1].play());
    assertEquals(f.sessions.length, 1);
    assertEquals(f.sessions[0].closed, false);
  } finally {
    await f.close();
  }
});

Deno.test('held idle transport remains busy until its connection is released', async () => {
  const f = await fixture();
  try {
    f.outputs.update('11', { connectionStrategy: 'owntone' });
    await f.playback[0].play();
    await until(() => f.sessions[0]?.bytes > 0);
    f.playback[0].pause();
    await busy(() => f.playback[1].play());
    assertEquals(f.sessions[0].closing, false);
    f.outputs.setMembers(1, []);
    await until(() => f.sessions[0].closed);
    await f.playback[1].play();
    await until(() => f.sessions[1]?.bytes > 0);
  } finally {
    await f.close();
  }
});

Deno.test('retry resumption cannot steal capacity acquired by a different player', async () => {
  const f = await fixture();
  try {
    await f.playback[0].play();
    await until(() => f.sessions[0]?.bytes > 0);
    f.sessions[0].event('state', 'failed');
    await until(() => f.sessions[0].closed && f.retry[0].length > 0);
    await f.playback[1].play();
    await until(() => f.sessions[1]?.bytes > 0);
    f.retry[0][0]();
    await until(() => f.retry[0].length > 1);
    assertEquals(f.playback[0].playerView().state, 'pause');
    assertEquals(f.playback[1].playerView().state, 'play');
    assertEquals(f.sessions.length, 2);
    f.playback[1].pause();
    await until(() => f.sessions[1].closed);
    f.retry[0][1]();
    await until(() => f.sessions[2]?.bytes > 0);
    assertEquals(f.sessions[2].port, 7001);
  } finally {
    await f.close();
  }
});

Deno.test('prepared activation cannot revive when its reservation is released and reacquired', async () => {
  const f = await fixture();
  let demand = f.capacities[0].reserve();
  try {
    const prepared = await f.devices.protocol.prepare({
      id: '11',
      targetRevision: f.devices.admission.describe('11').targetRevision,
      signal: new AbortController().signal,
      isCurrent: () => true,
      capacity: f.capacities[0],
    });
    assert(prepared.ok);
    demand.release();
    demand = f.capacities[0].reserve();
    const result = await f.devices.protocol.activate(prepared.value, {
      volume: 50,
      positionMs: 0,
      lengthMs: 1000,
      title: '',
      artist: '',
    }, { publish() {}, onEvent() {} });
    assert(!result.ok);
    assertEquals(f.sessions.length, 0);
    demand.release();
    await f.playback[1].play();
    await until(() => f.sessions[0]?.bytes > 0);
    assertEquals(f.sessions[0].port, 7002);
  } finally {
    demand.release();
    await f.close();
  }
});

Deno.test('capacity waits for every receiver connection, not just the elected PCM writer', async () => {
  const f = await fixture(), held = deferred();
  try {
    f.outputs.register({
      id: '33',
      name: 'Peer',
      type: 'AirPlay',
      host: '127.0.0.1',
      port: 7003,
      volume: 80,
      selected: false,
      playerId: 1,
    });
    await f.playback[0].play();
    await until(() =>
      f.sessions.length === 2 && f.sessions.some((s) => s.bytes > 0)
    );
    const heldPeer = f.sessions.find((s) => s.port === 7003)!;
    heldPeer.closeGate = held.promise;
    f.playback[0].stop();
    await until(() => heldPeer.closing && f.sessions.some((s) => s.closed));
    await busy(() => f.playback[1].play());
    held.resolve();
    await until(() => f.sessions.every((s) => s.closed));
    await f.playback[1].play();
    await until(() => f.sessions.some((s) => s.port === 7002 && s.bytes > 0));
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('natural advancement retains the stream and releases it after end-of-queue cleanup', async () => {
  const held = deferred(), f = await fixture({ eofGate: held.promise });
  try {
    await f.playback[0].play();
    const first = f.playback[0].playerView().current!.id;
    await until(() => f.eofEntered());
    assert(f.sessions[0].bytes > 0);
    // Expiring the clock is not source completion. The standalone fixture
    // supplies its own ticks, so retry only after the actual EOF is accepted.
    f.times[0] += f.playback[0].playerView().itemLengthMs + 1;
    await f.playback[0].advanceEnded();
    assertEquals(f.playback[0].playerView().current!.id, first);
    assertEquals(f.sessions.length, 1);
    assertEquals(f.sessions[0].closed, false);
    await busy(() => f.playback[1].play());
    held.resolve();
    await until(() => f.sourceEnds[0].has(first));
    await f.playback[0].advanceEnded();
    await until(() => f.sessions[1]?.bytes > 0);
    const second = f.playback[0].playerView().current!.id;
    await until(() => f.sourceEnds[0].has(second));
    await busy(() => f.playback[1].play());
    f.times[0] += f.playback[0].playerView().itemLengthMs + 1;
    await f.playback[0].advanceEnded();
    assertEquals(f.playback[0].playerView().state, 'stop');
    await until(() => f.sessions.every((s) => s.closed));
    await f.playback[1].play();
    await until(() => f.sessions.some((s) => s.port === 7002 && s.bytes > 0));
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('restore reserves synchronously and an immediate pause cancels its pending start', async () => {
  const f = await fixture(), held = deferred();
  try {
    f.targetGates[0] = held.promise;
    const engine = f.playback[0];
    const restoring = engine.restore({
      queue: engine.queueView().items,
      state: 'play',
      currentIndex: 0,
      positionMs: 0,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    const canceled = assertRejects(
      async () => await restoring,
      PlaybackError,
      'cancelled',
    );
    engine.pause();
    await f.playback[1].play();
    await until(() => f.sessions[0]?.bytes > 0);
    held.resolve();
    await canceled;
    assertEquals(f.sessions.map((s) => s.port), [7002]);
    assertEquals(engine.playerView().state, 'stop');
  } finally {
    held.resolve();
    await f.close();
  }
});

for (const phase of ['ids', 'target'] as const) {
  Deno.test(`cancellation after reference preparation hands off the reservation to ${phase}`, async () => {
    const f = await fixture(), held = deferred();
    let pending: Promise<unknown> | undefined;
    try {
      const before = f.entered[0].filter((step) => step === phase).length;
      f[phase === 'ids' ? 'idGates' : 'targetGates'][0] = held.promise;
      pending = f.playback[0].queueAddReferences([
        { kind: 'song', id: f.songs[0].id },
      ], { play: true, clear: true }).then(() => null, (error) => error);
      await until(() =>
        f.entered[0].filter((step) => step === phase).length > before
      );
      f.playback[0].pause();
      await f.playback[1].play();
      await until(() => f.sessions[0]?.bytes > 0);
      held.resolve();
      const error = await pending;
      assert(error instanceof PlaybackError);
      assertEquals(error.code, 'playback_cancelled');
      assertEquals(f.playback[0].queueView().items.length, 2);
      assertEquals(f.sessions.map((session) => session.port), [7002]);
    } finally {
      held.resolve();
      await pending;
      await f.close();
    }
  });
}
