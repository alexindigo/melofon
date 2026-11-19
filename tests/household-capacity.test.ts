import { assert, assertEquals } from '@std/assert';
import { createOutputs } from '../src/player.ts';
import { createPlayers } from '../src/players.ts';
import { createPersistence } from '../src/persistence.ts';
import { createPlaybackReports } from '../src/playback-reports.ts';
import type { PlaybackCapacity } from '../src/playback-capacity.ts';
import { createAirplayDevices } from '../src/boots/airplay-device.ts';
import { recordingStream } from './helpers/airplay-devices.ts';
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
  const deviceDeps = {
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
  } satisfies Parameters<typeof createAirplayDevices>[0];
  const devices = createAirplayDevices({
    ...deviceDeps,
    ...(deviceDeps.spawn ? { stream: recordingStream(deviceDeps.spawn) } : {}),
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

// Track B b19 / section 3.1 row 25 replaces the temporary household singleton.
Deno.test('household simultaneous starts have independent fixed-player PCM and default binding', async () => {
  const f = await fixture();
  try {
    const starts = await Promise.allSettled([1, 2].map(async (id) => {
      await f.players.get(id).play();
    }));
    assertEquals(starts.map((r) => r.status), ['fulfilled', 'fulfilled']);
    await until(() => f.sessions.filter((s) => s.bytes > 0).length === 2);
    assertEquals(f.sessions.map((s) => s.port).sort(), [7001, 7002]);
    const first = f.players.get(1).playerView();
    await f.players.rename(1, 'Den');
    await f.players.setDefault(2);
    await f.players.playback.play();
    assertEquals(f.players.get(1).playerView(), first);
    assertEquals(f.sessions.length, 2);
  } finally {
    await f.close();
  }
});

Deno.test('household native AirPlay sends independent RTP on simultaneous starts', async () => {
  const receivers = [await startFakeRaop(), await startFakeRaop()];
  const dir = await dataDir(), store = await openStore(dir);
  const h = await household(store, [], receivers.map((r) => r.port));
  try {
    const starts = await Promise.allSettled([1, 2].map(async (id) => {
      await h.players.get(id).play();
    }));
    assertEquals(starts.map((r) => r.status), ['fulfilled', 'fulfilled']);
    await until(() =>
      receivers.every((r) => r.sessions.some((s) => s.audioPackets > 0))
    );
    assertEquals([1, 2].map((id) => h.players.get(id).playerView().state), [
      'play',
      'play',
    ]);
  } finally {
    await h.close();
    await store.close();
    for (const r of receivers) r.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('native AirPlay receivers get absolute speaker volumes at start and after linked slider changes', async () => {
  const receivers = [await startFakeRaop(), await startFakeRaop()];
  const dir = await dataDir(), store = await openStore(dir);
  const h = await household(store, [], receivers.map((r) => r.port));
  const levels = () =>
    receivers.map((r) => r.sessions.at(-1)?.volumeParams.at(-1));
  const received = async (a: number, b: number) => {
    await until(() =>
      levels().every((text, i) =>
        text !== undefined &&
        Math.abs(Number(text.split(':')[1]) - [a, b][i]) < 0.001
      )
    );
  };
  try {
    const home = h.players.get(1);
    await home.setVolume({ volume: 40 });
    h.outputs.update('11', { volume: 40 });
    h.outputs.update('22', { volume: 20 });
    await h.players.join(1, '22');
    await home.play();
    await received(-18, -24);
    await until(() =>
      receivers.every((r) => r.sessions.some((s) => s.audioPackets > 0))
    );
    await home.setVolume({ volume: 60 });
    await received(-12, -18);
    await h.players.setLinked(1, '22', false);
    await home.setVolume({ volume: 0 });
    // The unchanged native adapter maps absolute 0-100 to -30..0 dB.
    await received(-30, -18);
    h.outputs.update('11', { volume: 30 });
    await received(-21, -18);
    assertEquals(
      home.playerView().volume,
      0,
      'zero slider never multiplies an individual absolute change',
    );
    await h.players.setLinked(1, '22', true);
    await home.setVolume({ volume: 100 });
    await received(0, 0);
    assertEquals(h.outputs.list().map((row) => row.volume), [100, 100]);
  } finally {
    await h.close();
    await store.close();
    for (const r of receivers) r.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('household wiring admits every disjoint start path without changing the peer', async () => {
  const f = await fixture();
  try {
    await f.players.get(1).play();
    await until(() => f.sessions[0]?.bytes > 0);
    const other = f.players.get(2), before = f.players.get(1).playerView();
    const queue = f.players.get(1).queueView();
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
      await command();
      assertEquals(f.players.get(1).playerView(), before);
      assertEquals(f.players.get(1).queueView(), queue);
    }
    assertEquals(f.players.get(1).playerView().state, 'play');
    await until(() => f.sessions.some((s) => s.port === 7002 && s.bytes > 0));
  } finally {
    await f.close();
  }
});

Deno.test('joining disjoint AirPlay to a playing player saves membership without changing its peer', async () => {
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
    const before = f.outputs.get('11');
    const states = [
      await playbackState(1),
      await playbackState(2),
    ];
    let changes = 0;
    const unsubscribe = f.notify.subscribe((types) => {
      if (types.includes('outputs')) changes++;
    });
    await f.players.join(2, '22');
    unsubscribe();
    assert(changes > 0);
    assertEquals(f.outputs.get('11'), before);
    await f.persistence.drain();
    assertEquals(
      (await f.store.speakers.loadMemberships()).map((
        r,
      ) => [r.speakerId, r.playerId]),
      [['11', 1], ['22', 2]],
    );
    assertEquals([
      await playbackState(1),
      await playbackState(2),
    ], states);
    assertEquals([1, 2].map((id) => f.players.get(id).playerView().state), [
      'play',
      'play',
    ]);
    await until(() => f.sessions.some((s) => s.port === 7002 && s.bytes > 0));
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
    await f.players.get(2).play();
    await until(() => f.sessions.some((s) => s.port === 7002 && s.bytes > 0));
    assertEquals(f.sessions[0].bytes, 0);
    held.resolve();
    await until(() => f.sessions[0].bytes > 0);
    assertEquals(f.players.get(2).playerView().state, 'play');
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
    const oldSessions = f.sessions.filter((s) => s.port === 7001).length;
    active.closeGate = held.promise;
    await f.players.setSpeakers(2, ['11', '22']);
    await until(() => active.closing);
    assertEquals(f.players.get(1).playerView().state, 'pause');
    assertEquals(f.players.get(1).playerView().itemProgressMs, 200);
    await f.players.get(2).play();
    await until(() => f.sessions.some((s) => s.port === 7002 && s.bytes > 0));
    assertEquals(f.sessions.filter((s) => s.port === 7001).length, oldSessions);
    assertEquals(active.closed, false);
    held.resolve();
    await until(() =>
      active.closed &&
      f.sessions.filter((s) => s.port === 7001).length === oldSessions + 1
    );
    // The fake transport observes the elected shared-feed writer, not native
    // fanout. Both receivers now belong to Kitchen; either may be that writer.
    await until(() => f.sessions.some((s) => !s.closed && s.bytes > 0));
    assertEquals(f.players.get(1).playerView().state, 'pause');
  } finally {
    held.resolve();
    await f.close();
  }
});

for (const mode of ['newest', 'unreachable', 'unknown', 'stale'] as const) {
  Deno.test(`household restore ${mode} independently restores fresh reachable players and keeps queues and spots`, async () => {
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
        `UPDATE player_state SET updated_at = to_timestamp((${now} - (player_id - 1) * ${
          mode === 'stale' ? 600000 : 500
        }) / 1000.0)`,
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
      const onlyHome = mode === 'unreachable' || mode === 'stale';
      await until(() =>
        h.sessions.filter((s) => s.bytes > 0).length === (onlyHome ? 1 : 2)
      );
      assertEquals(
        h.sessions.map((s) => s.port).sort(),
        onlyHome ? [7001] : [7001, 7002],
      );
      assertEquals(
        [1, 2].map((id) => h.players.get(id).playerView().state),
        onlyHome ? ['play', 'pause'] : ['play', 'play'],
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

Deno.test('OwnTone playback routes command the default player without changing another stream', async () => {
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
    const peer = h.players.get(2).playerView(), session = h.sessions[0];
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
      assertEquals(response.status, 204, path);
      await response.arrayBuffer();
      assertEquals(h.players.get(2).playerView(), peer);
      assertEquals(session.closing, false);
    }
    assertEquals(h.sessions.filter((s) => s.port === 7002).length, 1);
  } finally {
    await h.close();
    await f.close();
  }
});

Deno.test('every OwnTone membership route transfers exclusive membership without a household busy refusal', async () => {
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
    for (
      const [path, body] of [
        ['22', { selected: true, volume: 12 }],
        ['22/toggle', {}],
        ['set', { outputs: [independent, '22'] }],
      ] as const
    ) {
      await h.players.setSpeakers(1, [independent]);
      await h.players.setSpeakers(2, ['22']);
      await h.players.get(2).play();
      await until(() =>
        h.sessions.some((s) => s.port === 7002 && s.bytes > 0 && !s.closed)
      );
      const response = await call(path, body);
      assertEquals(response.status, 204, path);
      await response.arrayBuffer();
      assertEquals(h.outputs.get('22')?.playerId, 1);
      if (path === '22') assertEquals(h.outputs.get('22')?.volume, 12);
      await h.persistence.drain();
      assert(
        (await f.store.speakers.loadMemberships()).some((r) =>
          r.speakerId === '22' && r.playerId === 1
        ),
      );
      assertEquals([1, 2].map((id) => h.players.get(id).playerView().state), [
        'play',
        'pause',
      ]);
    }
    // Off on another player's speaker never takes it or pauses its owner.
    await h.players.setSpeakers(2, ['22']);
    await h.players.get(2).play();
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
