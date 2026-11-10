import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createOutputs } from '../src/player.ts';
import { createPersistence } from '../src/persistence.ts';
import { createPlaybackReports } from '../src/playback-reports.ts';
import { createPlayers, PlayerError } from '../src/players.ts';
import { createNotify, type NotifyFn } from '../src/notify.ts';
import { createQueueResolver } from '../src/queue-source.ts';
import { createSpeakers } from '../src/speakers.ts';
import { restored } from './helpers/prepared.ts';
import { apiFixture } from './helpers/api.ts';
import { rawSql } from '../src/store/testing.ts';

async function dataDir() {
  return await restored('players', async (dir) => {
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
  }, 'melofon-players-');
}

async function household(
  store: Store,
  extra: Partial<Parameters<typeof createPlayers>[0]> = {},
) {
  const notify = createNotify();
  const persistence = createPersistence(store);
  const outputs = extra.outputs ?? createOutputs({ notify, persistence });
  const library = createLibrary(store);
  const nowPlaying = createNowPlaying(store);
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
    maxResumeAgeMs: 300_000,
    playback: {
      nowPlaying,
      library,
      cfg: {},
      resolveQueueReference: createQueueResolver({
        getSong: library.getSong,
        getStation: () => Promise.resolve(null),
      }),
    },
    ...extra,
  });
  return {
    players,
    reports,
    outputs,
    notify,
    persistence,
    library,
    async close() {
      await players.close();
      await reports.close();
      await persistence.drain();
    },
  };
}

Deno.test('registry engines have independent durable queues, clocks, modes and provenance with global occurrence ids', async () => {
  const dir = await dataDir();
  let store = await openStore(dir);
  let time = 1000;
  let f = await household(store, { clock: { monotonicNow: () => time } });
  try {
    const songs = await f.library.listSongs({ offset: 0, size: 3 });
    const kitchen = await f.players.create('Kitchen');
    const home = f.players.get(1), other = f.players.get(kitchen.id);
    const events: Parameters<NotifyFn>[] = [];
    f.notify.subscribe((...args) => events.push(args));
    const [a, b] = await Promise.all([
      home.queueAdd(songs.slice(0, 2), { play: true }, {
        kind: 'http',
        user: 'alice',
      }),
      other.queueAdd([songs[2]], { play: true }, { kind: 'http', user: 'bob' }),
    ]);
    assertEquals(new Set([...a, ...b].map((e) => e.id)).size, 3);
    home.seek({ positionMs: 100 }, { kind: 'http', user: 'alice' });
    other.seek({ positionMs: 600 }, { kind: 'http', user: 'bob' });
    other.pause({ kind: 'internal', via: 'test' });
    home.setRepeat('all');
    other.setConsume(true);
    other.setShuffle(true);
    home.setVolume({ volume: 60 });
    time += 200;
    assertEquals(home.playerView().itemProgressMs, 300);
    assertEquals(other.playerView().itemProgressMs, 600);
    assertEquals(f.players.serverRows().map((row) => row.commander), [
      'alice',
      'bob',
    ]);
    for (const type of ['player', 'queue', 'options', 'volume']) {
      const seen = events.filter(([types]) => types.includes(type));
      assert(seen.length > 0);
      for (const [, keys, audience] of seen) {
        assertEquals(keys?.[type]?.length, 1);
        assertEquals(audience, 'all');
      }
      assertEquals(
        [...new Set(seen.flatMap(([, keys]) => keys?.[type] ?? []))].sort(),
        type === 'volume' ? ['1'] : ['1', String(kitchen.id)],
      );
    }
    assertEquals(home.lastCommand()?.kind, 'volume');
    assertEquals(other.lastCommand()?.kind, 'shuffle');
    // Save fixed bookmarks, then a real close/reopen through the registry.
    home.pause();
    const qa = home.queueView(), qb = other.queueView();
    await f.close();
    const commands = await store.players.list();
    assert(commands.every((row) => row.commandedAtMs !== null));
    await store.close();
    store = await openStore(dir);
    f = await household(store, { clock: { monotonicNow: () => time } });
    const restoredHome = f.players.get(1),
      restoredKitchen = f.players.get(kitchen.id);
    assertEquals(restoredHome.queueView(), qa);
    assertEquals(restoredKitchen.queueView(), qb);
    assertEquals(restoredHome.playerView().itemProgressMs, 300);
    assertEquals(restoredKitchen.playerView().itemProgressMs, 600);
    assertEquals(restoredHome.playerView().repeat, 'all');
    assertEquals(restoredKitchen.playerView().consume, true);
    assertEquals(restoredKitchen.playerView().shuffle, true);
    assertEquals(restoredHome.playerView().state, 'pause');
    assertEquals(restoredKitchen.playerView().state, 'pause');
    const c = await restoredKitchen.queueAdd([songs[0]]);
    assert(c[0].id > Math.max(...a.map((e) => e.id), ...b.map((e) => e.id)));
    assertEquals(restoredHome.queueView(), qa);
    assertEquals(
      (await store.players.list()).map((row) => row.commandedAtMs)[0],
      commands[0].commandedAtMs,
      'restore does not manufacture a new command time',
    );
  } finally {
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('registry guards names and deletion, changes the live default and closes only the deleted engine', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  const bound: number[] = [], closed: number[] = [], retried: number[] = [];
  const f = await household(store, {
    createBoot(id, playback) {
      bound.push(id);
      return {
        retry: () => {
          retried.push(id);
          assertEquals(playback, f.players.get(id));
          return Promise.resolve();
        },
        close: () => {
          closed.push(id);
          return Promise.resolve();
        },
        changeCredentials: (_id, save) => save(),
        pair: () => Promise.resolve({ state: 'complete', saved: false }),
        submitPin: () => Promise.resolve({ state: 'complete', saved: false }),
      };
    },
  });
  try {
    const changes: Parameters<NotifyFn>[] = [];
    f.notify.subscribe((...args) => changes.push(args));
    await assertRejects(() => f.players.delete(1), PlayerError, 'last player');
    await assertRejects(
      () => f.players.create(' HOME '),
      PlayerError,
      'already in use',
    );
    await assertRejects(() => f.players.create('  '), PlayerError, 'required');
    const kitchen = await f.players.create(' Kitchen ');
    await assertRejects(
      () => f.players.delete(1),
      PlayerError,
      'default player',
    );
    await assertRejects(
      () => f.players.rename(kitchen.id, 'home'),
      PlayerError,
      'already in use',
    );
    await f.players.rename(kitchen.id, 'Den');
    assertEquals(f.players.list().map((row) => row.name), ['Home', 'Den']);
    const captured = f.players.playback.queueAdd;
    const songs = await f.library.listSongs({ offset: 0, size: 1 });
    await captured(songs);
    await f.players.setDefault(kitchen.id);
    await captured(songs);
    assertEquals(f.players.get(1).queueView().items.length, 1);
    assertEquals(f.players.get(kitchen.id).queueView().items.length, 1);
    assertEquals(bound, [1, kitchen.id]);
    assertEquals(closed, [], 'default change never closes or retargets a boot');
    const old = f.players.get(1);
    f.outputs.register({
      id: 'speaker',
      name: 'Saved',
      type: 'Test',
      selected: true,
      playerId: 1,
      volume: 40,
    });
    await f.outputs.adopt('speaker');
    await f.players.bootForSpeaker('speaker').retry('speaker');
    assertEquals(
      retried,
      [1],
      'changing the default does not retarget a member speaker boot',
    );
    await f.players.delete(1);
    assertEquals(closed, [1]);
    assertThrows(() => old.pause(), Error, 'closed');
    await assertRejects(async () => await old.queueAdd(songs), Error, 'closed');
    assertThrows(() => f.players.get(1), PlayerError, 'not found');
    assertEquals((await store.players.list()).length, 1);
    assertEquals((await store.players.list())[0].isDefault, true);
    assertEquals(f.outputs.get('speaker')?.playerId, null);
    assertEquals(f.persistence.savedOutput('speaker')?.playerId, null);
    assertEquals((await store.speakers.loadMemberships())[0].playerId, null);
    assertEquals(
      changes.filter(([types]) => types.includes('players')).map(([, keys]) =>
        keys?.players
      ),
      [[String(kitchen.id)], [String(kitchen.id)], [String(kitchen.id)], ['1']],
    );
    await f.persistence.drain();
    assertEquals(
      await rawSql(store).all('SELECT * FROM player_state WHERE player_id = 1'),
      [],
    );
    assertEquals(
      await rawSql(store).all('SELECT * FROM server_queue WHERE player_id = 1'),
      [],
    );
    await assertRejects(
      () => f.players.delete(kitchen.id),
      PlayerError,
      'last player',
    );
  } finally {
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
  assertEquals(closed, [1, 2]);
});

Deno.test('durable id reservation cannot publish after cancellation or deletion and never reuses its gap', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => entered = resolve);
  const hold = new Promise<void>((resolve) => release = resolve);
  let first = true;
  const wrapped: Store = {
    ...store,
    players: {
      ...store.players,
      async reserveQueueIds(count) {
        const start = await store.players.reserveQueueIds(count);
        if (first) {
          first = false;
          entered();
          await hold;
        }
        return start;
      },
    },
  };
  const f = await household(wrapped);
  try {
    const row = await f.players.create('Kitchen');
    const engine = f.players.get(row.id);
    const songs = await f.library.listSongs({ offset: 0, size: 1 });
    const pending = Promise.resolve(engine.queueAdd(songs));
    const rejected = assertRejects(() => pending, Error, 'cancelled');
    await waiting;
    await f.players.delete(row.id);
    release();
    await rejected;
    assertEquals(engine.queueView().items, []);
    const added = await f.players.get(1).queueAdd(songs);
    assertEquals(added[0].id, 2);
    assertEquals(
      await rawSql(store).all(
        `SELECT * FROM server_queue WHERE player_id = ${row.id}`,
      ),
      [],
    );
  } finally {
    release?.();
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('restore and target preparation use the owning player, not any household selected speaker', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  const kitchen = await store.players.create('Kitchen');
  const outputs = createOutputs();
  outputs.register({
    id: 'home',
    name: 'Home speaker',
    type: 'Test',
    selected: true,
    playerId: 1,
    volume: 50,
  });
  outputs.register({
    id: 'kitchen',
    name: 'Kitchen speaker',
    type: 'Test',
    selected: false,
    playerId: kitchen.id,
    volume: 50,
  });
  const prepared: string[] = [];
  const speakers = createSpeakers({
    outputs,
    adapterView: () => ({
      preparation: { state: 'unresolved', targetRevision: 0 },
    }),
    prepare: (id) => {
      prepared.push(id);
      return Promise.resolve(true);
    },
  });
  let f = await household(store, {
    outputs,
    targets: (id) => ({
      preparePlayback: (signal) => speakers.preparePlayback(signal, id),
      hasPlaybackTarget: () => speakers.hasPlaybackTarget(id),
    }),
  });
  try {
    const songs = await f.library.listSongs({ offset: 0, size: 2 });
    await f.players.get(1).queueAdd([songs[0]], { play: true });
    await f.players.get(kitchen.id).queueAdd([songs[1]], { play: true });
    assertEquals(prepared, ['home', 'kitchen']);
    assertEquals(
      f.players.serverRows().map((row) => row.speakers.map((s) => s.id)),
      [['home'], ['kitchen']],
    );
    await f.close();
    // Only Kitchen remains reachable. Home must restore paused even though a
    // household target exists, while Kitchen independently resumes.
    outputs.unregister('home');
    f = await household(store, {
      outputs,
      targets: (id) => ({
        preparePlayback: (signal) => speakers.preparePlayback(signal, id),
        hasPlaybackTarget: () => speakers.hasPlaybackTarget(id),
      }),
    });
    assertEquals(f.players.get(1).playerView().state, 'pause');
    assertEquals(f.players.get(kitchen.id).playerView().state, 'play');
    assertEquals(prepared, ['home', 'kitchen', 'kitchen']);
  } finally {
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('registry drives each engine end clock and drains clocks and subscriptions on close', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  let time = 0;
  const f = await household(store, { clock: { monotonicNow: () => time } });
  try {
    const kitchen = await f.players.create('Kitchen');
    const songs = await f.library.listSongs({ offset: 0, size: 2 });
    const finite = songs.map((song) => ({ ...song, durationMs: 1000 }));
    await f.players.get(1).queueAdd(finite, { play: true });
    await f.players.get(kitchen.id).queueAdd([finite[0]], { play: true });
    time = 1500;
    const until = Date.now() + 3000;
    while (
      f.players.get(kitchen.id).playerView().state !== 'stop' &&
      Date.now() < until
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(f.players.get(1).playerView().current?.reference, {
      kind: 'song',
      id: finite[1].id,
    });
    assertEquals(f.players.get(kitchen.id).playerView().state, 'stop');
  } finally {
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('OwnTone HTTP services captured at load time follow the household default without changing wire shapes', async () => {
  let h!: Awaited<ReturnType<typeof household>>;
  const f = await apiFixture({
    storeDir: await dataDir(),
    hats: {
      layersRoot: 'layers/',
      extraPorts: 2,
      env: (ports) => ({ MELOFON_LISTEN_owntone: ports.join(',') }),
    },
    services: async ({ store }) => {
      h = await household(store);
      const songs = await h.library.listSongs({ offset: 0, size: 2 });
      await h.players.get(1).queueAdd([songs[0]]);
      const kitchen = await h.players.create('Kitchen');
      await h.players.get(kitchen.id).queueAdd([songs[1]]);
      return {
        library: h.library,
        outputs: h.outputs,
        playback: h.players.playback,
      };
    },
  });
  const call = (path: string, method = 'GET') =>
    fetch(`http://melofon.home:${f.extraPorts[0]}${path}`, {
      method,
      signal: AbortSignal.timeout(5000),
    });
  try {
    const home = await (await call('/api/queue')).json();
    assertEquals(home.items.length, 1);
    await h.players.setDefault(2);
    const kitchen = await (await call('/api/queue')).json();
    assertEquals(kitchen.items.length, 1);
    assert(home.items[0].id !== kitchen.items[0].id);
    assertEquals(Object.keys(home).sort(), Object.keys(kitchen).sort());
    assertEquals(
      (await call('/api/player/consume?state=true', 'PUT')).status,
      204,
    );
    assertEquals(h.players.get(1).playerView().consume, false);
    assertEquals(h.players.get(2).playerView().consume, true);
    assertEquals((await call('/api/player')).status, 200);
  } finally {
    await h.close();
    await f.close();
  }
});
