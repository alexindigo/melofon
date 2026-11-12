import { assert, assertEquals, assertRejects } from '@std/assert';
import { createOutputs } from '../src/player.ts';
import { createPlayers } from '../src/players.ts';
import { createPersistence } from '../src/persistence.ts';
import { createPlaybackReports } from '../src/playback-reports.ts';
import { PlaybackError } from '../src/playback-errors.ts';
import type { PlaybackCapacity } from '../src/playback-capacity.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { createAirplayBoot } from '../src/boots/airplay.ts';
import type { HelperEventFn } from '../src/boots/airplay-profile.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createNotify } from '../src/notify.ts';
import { createMedia } from '../src/media.ts';
import { openStore, type Store } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createLibrary } from '../src/library.ts';
import { createLibraries } from '../src/libraries.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { scanLibrary } from '../src/scan.ts';
import { createQueueResolver } from '../src/queue-source.ts';
import { restored } from './helpers/prepared.ts';
import { receiver, until } from './helpers/speaker-consumer.ts';
import { apiFixture } from './helpers/api.ts';
import { startFakeRaop } from './helpers/fake-raop.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);
  return { promise, resolve };
}

async function dataDir() {
  return await restored('household-capacity', async (dir) => {
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
  }, 'melofon-household-capacity-');
}

async function household(
  store: Store,
  unavailable: number[] = [],
  nativePorts?: number[],
) {
  const notify = createNotify(), persistence = createPersistence(store);
  const outputs = createOutputs({ notify, persistence });
  for (const row of await persistence.loadOutputs()) {
    outputs.restore({ ...row, ...persistence.savedOutput(row.id) });
  }
  type Session = {
    event: HelperEventFn;
    port: number;
    bytes: number;
    closing: boolean;
    closed: boolean;
    closeGate?: Promise<void>;
  };
  const sessions: Session[] = [];
  const startGates: (Promise<void> | undefined)[] = [];
  const devices = createAirplayDevices({
    outputs,
    changed: () => notify.emit(['outputs'], undefined, 'all'),
    resolver: {
      resolve: (_host, port) =>
        unavailable.includes(port!)
          ? Promise.reject(new Error('Receiver unavailable'))
          : Promise.resolve(receiver(port! - 7000, port!)),
      close() {},
    },
    spawn: nativePorts ? undefined : (event) => {
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
    prepare: (id, signal) =>
      outputs.get(id)?.type === 'AirPlay'
        ? devices.preparePlayback(id, signal)
        : Promise.resolve(true),
  });
  const library = createLibrary(store), nowPlaying = createNowPlaying(store);
  const reports = createPlaybackReports({
    nowPlaying,
    library,
    notify,
    serverRows: () => players.serverRows(),
  });
  const players = await createPlayers({
    store,
    persistence,
    outputs,
    reports,
    notify,
    // Spread keeps these consumer tests executable against the pre-wiring BASE.
    ...{ capacity: devices.capacity },
    maxResumeAgeMs: 300000,
    clock: { monotonicNow: () => 0 },
    playback: {
      library,
      nowPlaying,
      cfg: {},
      resolveQueueReference: createQueueResolver({
        getSong: library.getSong,
        getStation: () => Promise.resolve(null),
      }),
    },
    targets: (id) => ({
      hasPlaybackTarget: () => speakers.hasPlaybackTarget(id),
      preparePlayback: (signal) => speakers.preparePlayback(signal, id),
    }),
    createBoot(playerId, playback, outputs, capacity?: PlaybackCapacity) {
      return createAirplayBoot({
        playerId,
        playback,
        outputs,
        capacity,
        devices,
        notify,
        media: createMedia(),
      });
    },
  });
  const songs = await library.listSongs({ offset: 0, size: 2 });
  if (players.list().length === 1) {
    await players.create('Kitchen');
    for (const id of [1, 2]) {
      outputs.register({
        id: String(id * 11),
        name: `Speaker ${id}`,
        type: 'AirPlay',
        host: '127.0.0.1',
        port: nativePorts?.[id - 1] ?? 7000 + id,
        selected: false,
        volume: 80,
      });
      await outputs.adopt(String(id * 11));
      await players.join(id, String(id * 11));
      await players.get(id).queueAdd(songs);
    }
  }
  return {
    players,
    outputs,
    devices,
    sessions,
    startGates,
    notify,
    persistence,
    library,
    songs,
    async close() {
      await players.close();
      await reports.close();
      devices.close();
      await persistence.drain();
    },
  };
}

async function fixture() {
  const dir = await dataDir(), store = await openStore(dir);
  const h = await household(store);
  return {
    ...h,
    store,
    dir,
    async close() {
      await h.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function busy(command: () => unknown, id = 1, name = 'Home') {
  const error = await assertRejects(async () => {
    await command();
  }, PlaybackError);
  assertEquals(error.code, 'airplay_busy');
  assertEquals(error.owner, { id, name });
  assertEquals(error.message, `AirPlay is busy in ${name}`);
}

async function independentPlayer(
  h: Awaited<ReturnType<typeof household>>,
  id: number,
) {
  const speaker = String(90 + id);
  h.outputs.register({
    id: speaker,
    name: 'Independent test sink',
    type: 'Test',
    host: '127.0.0.1',
    selected: false,
    volume: 50,
  });
  await h.players.setSpeakers(id, [speaker]);
  await h.players.get(id).play();
  return speaker;
}

Deno.test('household simultaneous starts have one typed busy loser and one fixed-player PCM winner', async () => {
  const f = await fixture();
  try {
    const starts = await Promise.allSettled([1, 2].map(async (id) => {
      await f.players.get(id).play();
    }));
    assertEquals(starts.filter((r) => r.status === 'fulfilled').length, 1);
    const winner = starts.findIndex((r) => r.status === 'fulfilled') + 1;
    const rejected = starts.find((r) =>
      r.status === 'rejected'
    ) as PromiseRejectedResult;
    assert(rejected.reason instanceof PlaybackError);
    assertEquals(rejected.reason.code, 'airplay_busy');
    assertEquals(rejected.reason.owner, {
      id: winner,
      name: winner === 1 ? 'Home' : 'Kitchen',
    });
    await until(() => f.sessions.some((s) => s.bytes > 0));
    assertEquals(f.sessions.length, 1);
    assertEquals(f.sessions[0].port, 7000 + winner);
    await f.players.rename(winner, 'Den');
    await f.players.setDefault(3 - winner);
    await busy(() => f.players.playback.play(), winner, 'Den');
    assertEquals(f.players.get(winner).playerView().state, 'play');
    assertEquals(f.sessions.length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('household native AirPlay sends RTP to exactly one fake receiver on simultaneous starts', async () => {
  const receivers = [await startFakeRaop(), await startFakeRaop()];
  const dir = await dataDir(), store = await openStore(dir);
  const h = await household(store, [], receivers.map((r) => r.port));
  try {
    const starts = await Promise.allSettled([1, 2].map(async (id) => {
      await h.players.get(id).play();
    }));
    assertEquals(starts.filter((r) => r.status === 'fulfilled').length, 1);
    const winner = starts.findIndex((r) => r.status === 'fulfilled');
    const loser = starts[1 - winner] as PromiseRejectedResult;
    assert(loser.reason instanceof PlaybackError);
    assertEquals(loser.reason.code, 'airplay_busy');
    assertEquals(loser.reason.owner, {
      id: winner + 1,
      name: winner === 0 ? 'Home' : 'Kitchen',
    });
    await until(() =>
      receivers[winner].sessions.some((s) => s.audioPackets > 0)
    );
    assertEquals(receivers[1 - winner].sessions.length, 0);
    assertEquals(h.players.get(winner + 1).playerView().state, 'play');
    assertEquals(h.players.get(2 - winner).playerView().state, 'stop');
  } finally {
    await h.close();
    await store.close();
    for (const r of receivers) r.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('household wiring refuses every competing start before queue or play-state mutation', async () => {
  const f = await fixture();
  try {
    await f.players.get(1).play();
    await until(() => f.sessions[0]?.bytes > 0);
    const other = f.players.get(2), before = other.queueView();
    for (
      const command of [
        () => other.play(),
        () => other.toggle(),
        () => other.next(),
        () => other.previous(),
        () => other.seek({ positionMs: 200 }),
        () => other.queueAdd(f.songs, { clear: true, play: true }),
        () =>
          other.queueAddReferences([{ kind: 'song', id: f.songs[0].id }], {
            play: true,
          }),
      ]
    ) {
      await busy(command);
      assertEquals(other.queueView(), before);
      assertEquals(other.playerView().state, 'stop');
    }
    assertEquals(f.players.get(1).playerView().state, 'play');
    assertEquals(f.sessions.length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('joining AirPlay to a second playing player refuses before either membership or bookmark changes', async () => {
  const f = await fixture();
  const playbackState = async (id: number) => {
    const row = await f.store.playback.loadPlayerState(id);
    if (!row) return row;
    const { updatedAtMs: _updatedAtMs, ...playback } = row;
    return playback;
  };
  try {
    await independentPlayer(f, 2);
    await f.players.get(1).play();
    await until(() => f.sessions[0]?.bytes > 0);
    await f.persistence.drain();
    const before = f.outputs.list(),
      memberships = await f.store.speakers.loadMemberships();
    const states = [
      await playbackState(1),
      await playbackState(2),
    ];
    const last = f.outputs.lastCommand(),
      commands = await f.store.players.list();
    let changes = 0;
    const unsubscribe = f.notify.subscribe((types) => {
      if (types.includes('outputs')) changes++;
    });
    await busy(() => f.players.join(2, '11'));
    await busy(() => f.players.setSpeakers(2, ['11', '22']));
    unsubscribe();
    assertEquals(changes, 0);
    assertEquals(f.outputs.list(), before);
    assertEquals(f.outputs.lastCommand(), last);
    await f.persistence.drain();
    assertEquals(await f.store.speakers.loadMemberships(), memberships);
    assertEquals(await f.store.players.list(), commands);
    assertEquals([
      await playbackState(1),
      await playbackState(2),
    ], states);
    assertEquals([1, 2].map((id) => f.players.get(id).playerView().state), [
      'play',
      'play',
    ]);
    assertEquals(f.sessions.length, 1);
    assertEquals(f.sessions[0].closing, false);
  } finally {
    await f.close();
  }
});

Deno.test('membership hands the active demand to playback before asynchronous AirPlay activation', async () => {
  const f = await fixture(), held = deferred();
  try {
    await independentPlayer(f, 1);
    f.startGates[0] = held.promise;
    await f.players.join(1, '11');
    await until(() => f.sessions.length === 1);
    await busy(() => f.players.get(2).play());
    assertEquals(f.sessions[0].bytes, 0);
    held.resolve();
    await until(() => f.sessions[0].bytes > 0);
    await busy(() => f.players.get(2).play());
    assertEquals(f.players.get(1).playerView().state, 'play');
  } finally {
    held.resolve();
    await f.close();
  }
});

Deno.test('transfer to a paused player preserves the old spot and cannot start until real cleanup', async () => {
  const f = await fixture(), held = deferred();
  try {
    await f.players.get(1).play();
    await f.players.get(1).seek({ positionMs: 200 });
    await until(() => f.sessions.some((s) => s.bytes > 0 && !s.closing));
    const active = f.sessions.findLast((s) => !s.closing)!;
    active.closeGate = held.promise;
    await f.players.setSpeakers(2, ['11', '22']);
    await until(() => active.closing);
    assertEquals(f.players.get(1).playerView().state, 'pause');
    assertEquals(f.players.get(1).playerView().itemProgressMs, 200);
    await busy(() => f.players.get(2).play());
    held.resolve();
    await until(() => f.sessions.every((s) => s.closed));
    await f.players.get(2).play();
    // The fake transport observes the elected shared-feed writer, not native
    // fanout. Both receivers now belong to Kitchen; either may be that writer.
    await until(() => f.sessions.some((s) => !s.closed && s.bytes > 0));
    assertEquals(f.players.get(1).playerView().state, 'pause');
  } finally {
    held.resolve();
    await f.close();
  }
});

for (const mode of ['newest', 'unreachable', 'unknown'] as const) {
  Deno.test(`household restore ${mode} uses command order, keeps losing queue and spot, and emits only winning PCM`, async () => {
    const dir = await dataDir();
    let store = await openStore(dir), h = await household(store);
    try {
      const queues = [
        h.players.get(1).queueView(),
        h.players.get(2).queueView(),
      ];
      await h.close();
      const now = Date.now();
      await store.players.saveChanges({
        players: [1, 2].map((id) => ({
          playerId: id,
          ...(mode === 'unknown'
            ? {}
            : { commandedAtMs: now - (id === 1 ? 2000 : 1000) }),
          // Home has the newer periodic bookmark, but Kitchen the newer command.
          state: {
            state: 'play',
            currentIndex: 0,
            positionMs: id * 100,
            repeat: 'all' as const,
            shuffle: true,
            consume: false,
          },
        })),
      });
      await rawSql(store).run(
        `UPDATE player_state SET updated_at = to_timestamp((${now} - (player_id - 1) * 500) / 1000.0)`,
      );
      if (mode === 'unknown') {
        await rawSql(store).run('UPDATE players SET commanded_at_ms = NULL');
      }
      const savedCommands = (await store.players.list()).map((r) =>
        r.commandedAtMs
      );
      await store.close();
      store = await openStore(dir);
      h = await household(store, mode === 'unreachable' ? [7002] : []);
      const winner = mode === 'newest' ? 2 : 1;
      await until(() => h.sessions.some((s) => s.bytes > 0));
      assertEquals(h.sessions.length, 1);
      assertEquals(h.sessions[0].port, 7000 + winner);
      assertEquals(
        [1, 2].map((id) => h.players.get(id).playerView().state),
        winner === 1 ? ['play', 'pause'] : ['pause', 'play'],
      );
      for (const id of [1, 2]) {
        assertEquals(h.players.get(id).playerView().itemProgressMs, id * 100);
        assertEquals(h.players.get(id).playerView().repeat, 'all');
        assertEquals(h.players.get(id).queueView(), queues[id - 1]);
      }
      await h.persistence.drain();
      assertEquals(
        (await store.players.list()).map((r) => r.commandedAtMs),
        savedCommands,
      );
    } finally {
      await h.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('OwnTone playback routes report the owning player without changing either engine', async () => {
  let h!: Awaited<ReturnType<typeof household>>;
  const f = await apiFixture({
    storeDir: await dataDir(),
    hats: {
      layersRoot: 'layers/',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async ({ store }) => {
      h = await household(store);
      return {
        library: h.library,
        outputs: h.players.defaultOutputs,
        playback: h.players.playback,
      };
    },
  });
  try {
    await h.players.get(2).play();
    await until(() => h.sessions[0]?.bytes > 0);
    await h.persistence.drain();
    for (
      const path of [
        'play',
        'toggle',
        'next',
        'previous',
        'seek?position_ms=200',
      ]
    ) {
      const response = await fetch(
        `http://melofon.home:${f.extraPorts[0]}/api/player/${path}`,
        {
          method: 'PUT',
          signal: AbortSignal.timeout(5000),
        },
      );
      assertEquals(response.status, 500, path);
      assertEquals(await response.text(), 'AirPlay is busy in Kitchen');
      assertEquals(h.players.get(1).playerView().state, 'stop');
      assertEquals(h.players.get(2).playerView().state, 'play');
    }
    assertEquals(h.sessions.length, 1);
  } finally {
    await h.close();
    await f.close();
  }
});

Deno.test('every OwnTone membership route refuses busy before transfer or preference mutation', async () => {
  let h!: Awaited<ReturnType<typeof household>>;
  const f = await apiFixture({
    storeDir: await dataDir(),
    hats: {
      layersRoot: 'layers/',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: async ({ store }) => {
      h = await household(store);
      return {
        library: h.library,
        outputs: h.players.defaultOutputs,
        playback: h.players.playback,
      };
    },
  });
  const call = (path: string, body: unknown) =>
    fetch(`http://melofon.home:${f.extraPorts[0]}/api/outputs/${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  try {
    const independent = await independentPlayer(h, 1);
    await h.players.get(2).play();
    await until(() => h.sessions[0]?.bytes > 0);
    const before = h.outputs.list();
    const saved = await f.store.speakers.loadMemberships();
    for (
      const [path, body] of [
        ['22', { selected: true, volume: 12 }],
        ['22/toggle', {}],
        ['set', { outputs: [independent, '22'] }],
      ] as const
    ) {
      const response = await call(path, body);
      assertEquals(response.status, 500, path);
      assertEquals(await response.text(), 'AirPlay is busy in Kitchen');
      assertEquals(h.outputs.list(), before);
      await h.persistence.drain();
      assertEquals(await f.store.speakers.loadMemberships(), saved);
      assertEquals([1, 2].map((id) => h.players.get(id).playerView().state), [
        'play',
        'play',
      ]);
      assertEquals(h.sessions[0].closing, false);
    }
    // Off on another player's speaker never takes it or pauses its owner.
    const off = await call('22', { selected: false });
    assertEquals(off.status, 204);
    await off.arrayBuffer();
    assertEquals(h.outputs.get('22')?.playerId, 2);
    assertEquals(h.players.get(2).playerView().state, 'play');
  } finally {
    await h.close();
    await f.close();
  }
});
