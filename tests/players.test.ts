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
import { SpeakerError } from '../src/speaker-errors.ts';
import { outputAuthority } from '../src/player-outputs.ts';
import { until } from './helpers/speaker-consumer.ts';

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
  if (!extra.outputs) {
    for (const row of await persistence.loadOutputs()) {
      outputs.restore({ ...row, ...persistence.savedOutput(row.id) });
    }
  }
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

Deno.test('saved player sliders move only linked members by a capped delta and zero silences them', async () => {
  const dir = await dataDir();
  let store = await openStore(dir);
  await store.players.saveChanges({ players: [{ playerId: 1, volume: 40 }] });
  let f = await household(store);
  try {
    const kitchen = await f.players.create('Kitchen');
    const home = f.players.get(1), other = f.players.get(kitchen.id);
    assertEquals(home.playerView().volume, 40);
    assertEquals(other.playerView().volume, 50);
    assertEquals(
      await store.playback.loadPlayerState(1),
      null,
      'saved volume initializes without a bookmark',
    );
    for (
      const [id, volume] of [['11', 40], ['12', 20], ['13', 70], [
        '14',
        15,
      ]] as const
    ) {
      registerSpeaker(f, id);
      f.outputs.update(id, { volume });
      await f.outputs.adopt(id);
    }
    await f.players.setSpeakers(1, ['11', '12']);
    await f.players.join(kitchen.id, '13');
    registerSpeaker(f, 'temporary');
    await f.players.join(1, 'temporary');
    assertEquals(f.outputs.get('12')?.linked, true);
    await home.setVolume({ volume: 60 }, { kind: 'http', user: 'alice' });
    assertEquals(
      ['11', '12', 'temporary'].map((id) => f.outputs.get(id)?.volume),
      [60, 40, 60],
    );
    assertEquals(f.outputs.get('13')?.volume, 70);
    assertEquals(f.outputs.get('14')?.volume, 15);
    assertEquals(other.playerView().volume, 50);
    assertEquals(f.players.list()[0].volume, 60);
    f.outputs.update('11', { volume: 95 });
    assertEquals(
      home.playerView().volume,
      60,
      'a speaker change never moves the slider or its peers',
    );
    assertEquals(f.outputs.get('12')?.volume, 40);
    await f.players.setLinked(1, '12', false);
    await home.setVolume({ step: 20 });
    assertEquals([
      home.playerView().volume,
      f.outputs.get('11')?.volume,
      f.outputs.get('12')?.volume,
    ], [80, 100, 40]);
    await home.setVolume({ step: -20 });
    assertEquals(
      f.outputs.get('11')?.volume,
      80,
      'capping loses the former balance',
    );
    await f.players.setLinked(1, '12', true);
    assertEquals(
      f.outputs.get('12')?.volume,
      40,
      'relinking changes no speaker number',
    );
    await home.setVolume({ volume: -20 });
    assertEquals(home.playerView().volume, 0);
    assertEquals(
      ['11', '12', 'temporary'].map((id) => f.outputs.get(id)?.volume),
      [0, 0, 0],
    );
    f.outputs.update('12', { volume: 25 });
    await f.players.setLinked(1, '12', false);
    await home.setVolume({ volume: 0 });
    assertEquals(
      f.outputs.get('12')?.volume,
      25,
      'zero does not silence an unlinked member',
    );
    f.outputs.update('11', { volume: 70 });
    await home.setVolume({ volume: 0 });
    assertEquals(
      f.outputs.get('11')?.volume,
      0,
      'reasserting zero also silences linked members',
    );
    await home.setVolume({ volume: 200, step: -100 });
    assertEquals(
      home.playerView().volume,
      100,
      'absolute wins, and the player itself is capped',
    );
    assertEquals(f.outputs.get('11')?.volume, 100);
    assertEquals(f.outputs.get('12')?.volume, 25);
    await home.setVolume({ volume: 37 });
    await other.setVolume({ volume: 22 });
    assertEquals(f.outputs.get('13')?.volume, 42);
    await assertRejects(
      () => f.players.setLinked(kitchen.id, '12', true),
      SpeakerError,
      'not found',
    );
    const preferences = () =>
      f.outputs.list().filter((row) => row.id !== 'temporary').map((
        { id, playerId, linked, volume },
      ) => ({
        id,
        playerId: playerId ?? null,
        linked: linked ?? true,
        volume,
      }));
    const before = preferences();
    const commands = (await store.players.list()).map((row) =>
      row.commandedAtMs
    );
    await f.close();
    await store.close();
    store = await openStore(dir);
    f = await household(store);
    assertEquals([
      f.players.get(1).playerView().volume,
      f.players.get(kitchen.id).playerView().volume,
    ], [37, 22]);
    assertEquals(preferences(), before);
    assertEquals(
      f.outputs.get('temporary'),
      null,
      'temporary volume and membership are never adopted by a slider',
    );
    assertEquals(
      f.players.get(1).queueView().items,
      [],
      'volume restore does not need a queue',
    );
    assertEquals(
      (await store.players.list()).map((row) => row.commandedAtMs),
      commands,
      'restoring volume is not a command',
    );
    await f.players.join(kitchen.id, '12');
    assertEquals(
      f.outputs.get('12')?.linked,
      true,
      'joining a new owner resets the link',
    );
    assertEquals(
      f.outputs.get('12')?.volume,
      25,
      'joining never changes the absolute number',
    );
  } finally {
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('a published slider succeeds while its saved batch rolls back and retries before a later speaker write', async () => {
  const dir = await dataDir(), store = await openStore(dir);
  await store.players.saveChanges({ players: [{ playerId: 1, volume: 40 }] });
  let fail = false;
  const batches: Parameters<Store['players']['saveChanges']>[0][] = [];
  const wrapped: Store = {
    ...store,
    players: {
      ...store.players,
      saveChanges(changes) {
        if (changes.players?.some((row) => row.volume !== undefined)) {
          batches.push(structuredClone(changes));
          if (fail) {
            return store.players.saveChanges({
              ...changes,
              speakerVolumes: [{ speakerId: '11', volume: 101 }],
            });
          }
        }
        return store.players.saveChanges(changes);
      },
    },
  };
  const f = await household(wrapped);
  try {
    for (const [id, volume] of [['11', 40], ['12', 20]] as const) {
      registerSpeaker(f, id);
      f.outputs.update(id, { volume });
      await f.outputs.adopt(id);
    }
    await f.players.setSpeakers(1, ['11', '12']);
    fail = true;
    await f.players.get(1).setVolume({ volume: 60 }, {
      kind: 'http',
      user: 'alice',
    });
    assertEquals(f.persistence.health(), { pendingWrites: 1 });
    assertEquals((await store.players.list())[0].volume, 40);
    assertEquals(
      (await store.speakers.loadAdopted()).map((row) => row.volume),
      [40, 20],
    );
    assertEquals(f.players.get(1).playerView().volume, 60);
    assertEquals(f.outputs.list().map((row) => row.volume), [60, 40]);
    assertEquals(batches[0].players?.map((row) => row.volume), [60]);
    assert(batches[0].players?.[0].commandedAtMs !== undefined);
    assertEquals(batches[0].outputs?.map((row) => row.volume), [60, 40]);
    fail = false;
    f.outputs.update('11', { volume: 65 });
    await f.persistence.drain();
    assertEquals(f.persistence.health(), { pendingWrites: 0 });
    assertEquals(batches[1], batches[0]);
    assertEquals((await store.players.list())[0].volume, 60);
    assertEquals(
      (await store.speakers.loadAdopted()).map((row) => row.volume),
      [65, 40],
    );
    const first = f.players.get(1).setVolume({ step: -10 });
    const second = f.players.get(1).setVolume({ step: 20 });
    await Promise.all([first, second]);
    assertEquals((await store.players.list())[0].volume, 70);
    assertEquals(
      (await store.speakers.loadAdopted()).map((row) => row.volume),
      [75, 50],
    );
    assertEquals(f.persistence.savedOutput('11')?.volume, 75);
  } finally {
    fail = false;
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

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

Deno.test('registry close waits for every engine release before propagating a disposal failure', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failure = new Error('Home boot close failed');
  const f = await household(store, {
    createBoot(id) {
      return {
        retry: () => Promise.resolve(),
        changeCredentials: (_id, save) => save(),
        pair: () => Promise.resolve({ state: 'complete', saved: false }),
        submitPin: () => Promise.resolve({ state: 'complete', saved: false }),
        async close() {
          if (id === 1) throw failure;
          entered.resolve();
          await release.promise;
        },
      };
    },
  });
  let closing: Promise<void> | undefined;
  try {
    await f.players.create('Kitchen');
    let settled = false;
    closing = f.players.close();
    void closing.then(() => settled = true, () => settled = true);
    await entered.promise;
    // Let Home finish its persistence release while Kitchen still owns its boot.
    await f.persistence.drain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(
      settled,
      false,
      'shared owners must outlive every engine release',
    );
    release.resolve();
    await assertRejects(
      () => closing!,
      AggregateError,
      'Player registry close failed',
    );
    assertEquals(f.players.list(), []);
  } finally {
    release.resolve();
    await closing?.catch(() => {});
    await f.reports.close();
    await f.persistence.close();
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

function registerSpeaker(f: Awaited<ReturnType<typeof household>>, id: string) {
  f.outputs.register({
    id,
    name: `Speaker ${id}`,
    type: 'Test',
    selected: false,
    volume: 40,
  });
}

Deno.test('ordinary writes blocked by repeated membership failures remain ordered and durable', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  let fail = false;
  const f = await household({
    ...store,
    players: {
      ...store.players,
      saveChanges(changes) {
        if (fail && changes.outputs?.length) {
          return Promise.reject(new Error('membership unavailable'));
        }
        return store.players.saveChanges(changes);
      },
    },
  }, { clock: { monotonicNow: () => 0 } });
  try {
    const kitchen = await f.players.create('Kitchen');
    registerSpeaker(f, '11');
    await f.outputs.adopt('11');
    await f.players.join(1, '11');
    fail = true;
    await f.players.join(kitchen.id, '11');
    assertEquals(f.outputs.get('11')?.playerId, kitchen.id);
    f.outputs.update('11', { volume: 43 });
    const other = f.players.get(kitchen.id);
    await other.queueAdd(await f.library.listSongs({ offset: 0, size: 1 }));
    other.setRepeat('all');
    await assertRejects(() => f.persistence.drain());
    assertEquals((await store.speakers.loadMemberships())[0].playerId, 1);
    fail = false;
    await f.persistence.drain();
    assertEquals(
      (await store.speakers.loadMemberships())[0].playerId,
      kitchen.id,
    );
    assertEquals((await store.speakers.loadAdopted())[0].volume, 43);
    assertEquals((await store.playback.loadQueue(kitchen.id)).items.length, 1);
    assertEquals(
      (await store.playback.loadPlayerState(kitchen.id))?.repeat,
      'all',
    );
    assertEquals(
      (await store.players.list())[1].commandedAtMs,
      other.lastCommand()!.atMs,
    );
  } finally {
    fail = false;
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('HTTP membership succeeds after publication while health exposes and clears its pending whole-batch save', async () => {
  let h!: Awaited<ReturnType<typeof household>>;
  let fail = false;
  const f = await apiFixture({
    storeDir: await dataDir(),
    services: async ({ store }) => {
      h = await household({
        ...store,
        players: {
          ...store.players,
          saveChanges(changes) {
            if (fail && changes.outputs?.length) {
              return Promise.reject(new Error('private save failure'));
            }
            return store.players.saveChanges(changes);
          },
        },
      });
      await h.players.create('Kitchen');
      registerSpeaker(h, '11');
      await h.outputs.adopt('11');
      await h.players.join(1, '11');
      return { players: h.players, persistence: h.persistence };
    },
  });
  try {
    const { credential } = await f.login('bearer');
    fail = true;
    const joined = await f.json(
      '/api/v1/players/2/speakers/11',
      'PUT',
      {},
      credential,
    );
    assertEquals(joined.status, 204);
    assertEquals(h.outputs.get('11')?.playerId, 2);
    assertEquals((await f.store.speakers.loadMemberships())[0].playerId, 1);
    const degraded = await f.request('/_/health');
    assertEquals(degraded.status, 503);
    assertEquals(await degraded.json(), {
      ok: false,
      persistence: { pendingWrites: 1 },
    });
    fail = false;
    await until(() => h.persistence.health().pendingWrites === 0);
    const healthy = await f.request('/_/health');
    assertEquals(healthy.status, 200);
    assertEquals(await healthy.json(), { ok: true });
    assertEquals((await f.store.speakers.loadMemberships())[0].playerId, 2);
  } finally {
    fail = false;
    await h.close();
    await f.close();
  }
});

Deno.test('idle published membership and forget retry in order without another command', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  let fail = false;
  const writes: string[] = [];
  const f = await household({
    ...store,
    players: {
      ...store.players,
      async saveChanges(changes) {
        if (fail) throw new Error('storage offline');
        await store.players.saveChanges(changes);
        writes.push('membership');
      },
    },
    speakers: {
      ...store.speakers,
      async deleteAdopted(id) {
        const deleted = await store.speakers.deleteAdopted(id);
        writes.push('forget');
        return deleted;
      },
    },
  });
  try {
    const kitchen = await f.players.create('Kitchen');
    registerSpeaker(f, '11');
    await f.outputs.adopt('11');
    await f.players.join(1, '11');
    writes.length = 0;
    fail = true;
    await f.players.join(kitchen.id, '11');
    await f.outputs.forget('11');
    assertEquals(f.persistence.health(), { pendingWrites: 2 });
    assertEquals((await store.speakers.loadMemberships())[0].playerId, 1);
    fail = false;
    // No drain, tick, command or shutdown can drive this recovery.
    await until(() => f.persistence.health().pendingWrites === 0);
    assertEquals(writes, ['membership', 'forget']);
    assertEquals(await store.speakers.loadMemberships(), []);
    assertEquals(f.outputs.get('11'), null);
    assertEquals(f.players.get(kitchen.id).playerView().state, 'stop');
  } finally {
    fail = false;
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

for (const phase of ['cancellation', 'deletion'] as const) {
  Deno.test(`published speaker forget succeeds despite ${phase} failure without restoring membership or authority`, async () => {
    const dir = await dataDir();
    const store = await openStore(dir);
    let fail = true;
    const f = await household({
      ...store,
      speakers: {
        ...store.speakers,
        deleteAdopted(id) {
          if (fail && phase === 'deletion') {
            return Promise.reject(new Error('forget unavailable'));
          }
          return store.speakers.deleteAdopted(id);
        },
      },
    });
    const stop = f.outputs.onCommand(() => {
      if (fail && phase === 'cancellation') {
        throw new Error('forget unavailable');
      }
    });
    try {
      const kitchen = await f.players.create('Kitchen');
      registerSpeaker(f, '11');
      await f.outputs.adopt('11');
      await f.players.join(kitchen.id, '11');
      f.outputs.restore({ ...f.outputs.get('11')!, linked: false });
      await f.outputs.adopt('11');
      const authority = outputAuthority(f.outputs, '11');
      const forgotten = f.outputs.forget('11').then(
        () => undefined,
        (error) => error,
      );
      assertEquals(f.outputs.get('11'), null, 'forget publishes synchronously');
      assertEquals(await forgotten, undefined);
      assertEquals(f.persistence.savedOutput('11'), undefined);
      if (phase === 'deletion') {
        await assertRejects(
          () => f.persistence.drain(),
          Error,
          'forget unavailable',
        );
        assertEquals(f.persistence.health(), { pendingWrites: 1 });
        assertEquals(await store.speakers.loadMemberships(), [{
          speakerId: '11',
          playerId: kitchen.id,
          linked: false,
        }]);
      }
      assertEquals(
        authority(),
        false,
        'published forget never restores the old session grant',
      );
      fail = false;
      await f.persistence.drain();
      assertEquals(f.outputs.get('11'), null);
      assertEquals(await store.speakers.loadMemberships(), []);
      assertEquals(f.persistence.health(), { pendingWrites: 0 });
    } finally {
      stop?.();
      fail = false;
      await f.close();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('leave reports a rejected membership publication instead of success', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  const f = await household(store);
  try {
    for (const id of ['11', '12']) {
      registerSpeaker(f, id);
      await f.outputs.adopt(id);
      await f.players.join(1, id);
    }
    const setMembers = f.outputs.setMembers;
    f.outputs.setMembers = () => false;
    try {
      const error = await assertRejects(
        () => f.players.leave(1, '11'),
        SpeakerError,
      );
      assertEquals(error.code, 'speaker_busy');
      assertEquals(f.players.members(1).map((row) => row.id), ['11', '12']);
      assertEquals(
        (await store.speakers.loadMemberships()).map((row) => row.playerId),
        [1, 1],
      );
    } finally {
      f.outputs.setMembers = setMembers;
    }
    await f.players.leave(1, '11');
    assertEquals(f.players.members(1).map((row) => row.id), ['12']);
  } finally {
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('durable player deletion failure leaves its engine and boot usable for retry', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  let fail = true;
  const closed: number[] = [];
  const f = await household({
    ...store,
    players: {
      ...store.players,
      delete(id) {
        if (fail) return Promise.reject(new Error('delete unavailable'));
        return store.players.delete(id);
      },
    },
  }, {
    clock: { monotonicNow: () => 0 },
    createBoot(id) {
      return {
        retry: () => Promise.resolve(),
        changeCredentials: (_id, save) => save(),
        pair: () => Promise.resolve({ state: 'complete', saved: false }),
        submitPin: () => Promise.resolve({ state: 'complete', saved: false }),
        close: () => {
          closed.push(id);
          return Promise.resolve();
        },
      };
    },
  });
  try {
    const kitchen = await f.players.create('Kitchen');
    const engine = f.players.get(kitchen.id);
    const songs = await f.library.listSongs({ offset: 0, size: 1 });
    await engine.queueAdd(songs, { play: true });
    await assertRejects(
      () => f.players.delete(kitchen.id),
      Error,
      'delete unavailable',
    );
    assertEquals(f.players.list().map((row) => row.id), [1, kitchen.id]);
    assertEquals(f.players.get(kitchen.id), engine);
    assertEquals(closed, []);
    engine.pause();
    await engine.queueAdd(songs);
    await f.persistence.drain();
    assertEquals((await store.playback.loadQueue(kitchen.id)).items.length, 2);
    assertEquals(
      (await store.playback.loadPlayerState(kitchen.id))?.state,
      'pause',
    );
    fail = false;
    await f.players.delete(kitchen.id);
    assertEquals(closed, [kitchen.id]);
    assertEquals(f.players.list().map((row) => row.id), [1]);
    assertEquals((await store.players.list()).map((row) => row.id), [1]);
    assertThrows(() => engine.pause(), Error, 'closed');
  } finally {
    fail = false;
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('queue writes concurrent with durable player deletion cannot poison household persistence', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  let entered!: () => void, release!: () => void;
  const deleting = new Promise<void>((resolve) => entered = resolve);
  const hold = new Promise<void>((resolve) => release = resolve);
  const f = await household({
    ...store,
    players: {
      ...store.players,
      async delete(id) {
        await store.players.delete(id);
        entered();
        await hold;
      },
    },
  });
  try {
    const kitchen = await f.players.create('Kitchen');
    const engine = f.players.get(kitchen.id);
    const songs = await f.library.listSongs({ offset: 0, size: 1 });
    await engine.queueAdd(songs);
    const pending = f.players.delete(kitchen.id);
    await deleting;
    engine.setRepeat('all');
    release();
    await pending;
    await f.players.get(1).queueAdd(songs);
    await f.persistence.drain();
    assertEquals(f.persistence.health(), { pendingWrites: 0 });
    assertEquals((await store.playback.loadQueue(1)).items.length, 1);
    assertEquals((await store.players.list()).map((row) => row.id), [1]);
  } finally {
    release?.();
    try {
      await f.close();
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test('published player deletion releases runtime membership despite another player save failing during disposal', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  let fail = false;
  let triggered = false;
  const f = await household({
    ...store,
    playback: {
      ...store.playback,
      saveState(id, state) {
        if (fail && id === 1) {
          return Promise.reject(new Error('Home save offline'));
        }
        return store.playback.saveState(id, state);
      },
    },
  }, {
    createBoot(id) {
      return {
        retry: () => Promise.resolve(),
        changeCredentials: (_id, save) => save(),
        pair: () => Promise.resolve({ state: 'complete', saved: false }),
        submitPin: () => Promise.resolve({ state: 'complete', saved: false }),
        close: () => {
          if (id !== 1 && !triggered) {
            triggered = true;
            fail = true;
            f.players.get(1).setRepeat('all');
          }
          return Promise.resolve();
        },
      };
    },
  });
  try {
    const kitchen = await f.players.create('Kitchen');
    registerSpeaker(f, '11');
    await f.outputs.adopt('11');
    await f.players.join(kitchen.id, '11');
    const engine = f.players.get(kitchen.id);
    const events: Parameters<NotifyFn>[] = [];
    f.notify.subscribe((...event) => events.push(event));
    await f.players.delete(kitchen.id);
    assertEquals(f.players.list().map((row) => row.id), [1]);
    assertThrows(() => f.players.get(kitchen.id), PlayerError, 'not found');
    assertThrows(() => engine.pause(), Error, 'closed');
    assertEquals(f.players.freeSpeakers().map((row) => row.id), ['11']);
    assertEquals(f.persistence.savedOutput('11')?.playerId, null);
    assertEquals((await store.players.list()).map((row) => row.id), [1]);
    assertEquals((await store.speakers.loadMemberships())[0].playerId, null);
    assert(
      events.some(([types, keys]) =>
        types.includes('players') && keys?.players?.includes(String(kitchen.id))
      ),
    );
    assert(
      events.some(([types]) =>
        types.includes('outputs') && types.includes('nowPlaying')
      ),
    );
    assert(f.persistence.health().pendingWrites > 0);
    fail = false;
    await f.persistence.drain();
    assertEquals((await store.playback.loadPlayerState(1))?.repeat, 'all');
  } finally {
    fail = false;
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('membership join takes speakers, leave is owner-scoped and last-speaker loss durably pauses at the same queue spot', async () => {
  const dir = await dataDir();
  let store = await openStore(dir);
  let time = 0;
  let f = await household(store, { clock: { monotonicNow: () => time } });
  try {
    const kitchen = await f.players.create('Kitchen');
    for (const id of ['11', '12', '13']) {
      registerSpeaker(f, id);
      await f.outputs.adopt(id);
    }
    await f.players.join(1, '11');
    await f.players.join(1, '12');
    await f.players.join(kitchen.id, '13');
    f.outputs.restore({ ...f.outputs.get('11')!, linked: false });
    await f.outputs.adopt('11');
    await f.players.join(1, '11');
    assertEquals(
      f.outputs.get('11')?.linked,
      false,
      'joining the same owner is idempotent',
    );
    assertEquals(f.players.freeSpeakers(), []);
    const songs = await f.library.listSongs({ offset: 0, size: 2 });
    const home = f.players.get(1);
    await home.queueAdd(songs, { play: true }, { kind: 'http', user: 'alice' });
    home.seek({ positionMs: 150 });
    const queue = home.queueView();
    time += 200;
    await f.players.join(kitchen.id, '11');
    assertEquals(
      f.outputs.get('11')?.linked,
      true,
      'a new owner starts linked',
    );
    assertEquals(
      home.playerView().state,
      'play',
      'one remaining speaker keeps playing',
    );
    assertEquals(f.players.members(kitchen.id).map((row) => row.id), [
      '11',
      '13',
    ]);
    await f.players.leave(1, '11');
    assertEquals(
      f.outputs.get('11')?.playerId,
      kitchen.id,
      'leaving another owner never steals or frees it',
    );
    await f.players.join(kitchen.id, '12');
    assertEquals(home.playerView().state, 'pause');
    assertEquals(home.playerView().itemProgressMs, 350);
    assertEquals(home.queueView(), queue);
    assertEquals((await store.playback.loadPlayerState(1))?.state, 'pause');
    assertEquals((await store.playback.loadPlayerState(1))?.positionMs, 350);
    assertEquals(
      (await store.speakers.loadMemberships()).map((row) => row.playerId),
      [kitchen.id, kitchen.id, kitchen.id],
    );
    await f.players.leave(kitchen.id, '12');
    assertEquals(f.players.freeSpeakers().map((row) => row.id), ['12']);
    await f.players.join(1, '12');
    assertEquals(f.outputs.get('12')?.linked, true);
    await f.close();
    await store.close();
    store = await openStore(dir);
    f = await household(store, { clock: { monotonicNow: () => time } });
    assertEquals(f.players.members(1).map((row) => row.id), ['12']);
    assertEquals(f.players.members(kitchen.id).map((row) => row.id), [
      '11',
      '13',
    ]);
    assertEquals(f.players.get(1).queueView(), queue);
    assertEquals(f.players.get(1).playerView().state, 'pause');
    assertEquals(f.players.get(1).playerView().itemProgressMs, 350);
    for (const row of f.outputs.list()) {
      assertEquals(f.persistence.savedOutput(row.id)?.playerId, row.playerId);
    }
    await assertRejects(
      () => f.players.join(999, '11'),
      PlayerError,
      'not found',
    );
    await assertRejects(
      () => f.players.join(1, 'missing'),
      SpeakerError,
      'not found',
    );
  } finally {
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('membership publication serializes stale output snapshots, the induced pause and later preference writes', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => entered = resolve);
  const hold = new Promise<void>((resolve) => release = resolve);
  let delay = false;
  const batches: Parameters<Store['players']['saveChanges']>[0][] = [];
  const wrapped: Store = {
    ...store,
    playback: {
      ...store.playback,
      async saveOutput(row) {
        if (delay) {
          delay = false;
          entered();
          await hold;
        }
        await store.playback.saveOutput(row);
      },
    },
    players: {
      ...store.players,
      async saveChanges(changes) {
        if (changes.outputs?.length) batches.push(structuredClone(changes));
        await store.players.saveChanges(changes);
      },
    },
  };
  const f = await household(wrapped, { clock: { monotonicNow: () => 0 } });
  try {
    const kitchen = await f.players.create('Kitchen');
    registerSpeaker(f, '11');
    await f.outputs.adopt('11');
    await f.players.join(1, '11');
    await store.speakers.saveCredential(
      '11',
      'pairing-key',
      'opaque-existing-ciphertext',
    );
    const songs = await f.library.listSongs({ offset: 0, size: 1 });
    await f.players.get(1).queueAdd(songs, { play: true });
    f.players.get(1).seek({ positionMs: 200 });
    await f.persistence.drain();
    delay = true;
    f.outputs.update('11', { volume: 41 });
    await waiting;
    const moving = f.players.join(kitchen.id, '11');
    // Wait for the synchronous publication without releasing the older write.
    const published = new Promise<void>((resolve) => {
      const stop = f.notify.subscribe((types) => {
        if (
          types.includes('outputs') &&
          f.outputs.get('11')?.playerId === kitchen.id
        ) {
          stop();
          resolve();
        }
      });
    });
    await published;
    assertEquals(f.players.get(1).playerView().state, 'pause');
    assertEquals((await store.speakers.loadMemberships())[0].playerId, 1);
    assertEquals((await store.playback.loadPlayerState(1))?.state, 'play');
    f.outputs.update('11', { volume: 42 });
    release();
    await moving;
    await f.persistence.drain();
    const batch = batches.at(-1)!;
    assertEquals(batch.outputs?.[0].playerId, kitchen.id);
    assertEquals(
      batch.players?.find((row) => row.playerId === 1)?.state?.state,
      'pause',
    );
    assertEquals(
      (await store.speakers.loadMemberships())[0].playerId,
      kitchen.id,
    );
    assertEquals((await store.playback.loadPlayerState(1))?.positionMs, 200);
    assertEquals((await store.speakers.loadAdopted())[0].volume, 42);
    assertEquals(f.persistence.savedOutput('11')?.playerId, kitchen.id);
    assertEquals(
      await store.speakers.loadCredential('11', 'pairing-key'),
      'opaque-existing-ciphertext',
    );
  } finally {
    release();
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('failed membership save succeeds after publication and retries its whole paused bookmark batch', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  let fail = false;
  const wrapped: Store = {
    ...store,
    players: {
      ...store.players,
      saveChanges(changes) {
        return store.players.saveChanges(
          fail && changes.outputs?.length
            ? {
              ...changes,
              players: [...changes.players ?? [], {
                playerId: 999999,
                commandedAtMs: 1,
              }],
            }
            : changes,
        );
      },
    },
  };
  const f = await household(wrapped, { clock: { monotonicNow: () => 0 } });
  try {
    const kitchen = await f.players.create('Kitchen');
    registerSpeaker(f, '11');
    await f.outputs.adopt('11');
    await f.players.join(1, '11');
    await f.players.get(1).queueAdd(
      await f.library.listSongs({ offset: 0, size: 1 }),
      { play: true },
    );
    f.players.get(1).seek({ positionMs: 123 });
    await f.persistence.drain();
    fail = true;
    await f.players.join(kitchen.id, '11');
    assertEquals((await store.speakers.loadMemberships())[0].playerId, 1);
    assertEquals((await store.playback.loadPlayerState(1))?.state, 'play');
    assertEquals(f.players.get(1).playerView().state, 'pause');
    await assertRejects(() => f.persistence.drain(), Error, 'Player not found');
    fail = false;
    f.outputs.update('11', { volume: 43 });
    await f.persistence.drain();
    assertEquals((await store.playback.loadPlayerState(1))?.state, 'pause');
    assertEquals((await store.speakers.loadAdopted())[0].volume, 43);
    await f.players.join(kitchen.id, '11');
    assertEquals(
      (await store.speakers.loadMemberships())[0].playerId,
      kitchen.id,
    );
    assertEquals((await store.playback.loadPlayerState(1))?.state, 'pause');
    assertEquals((await store.playback.loadPlayerState(1))?.positionMs, 123);
  } finally {
    fail = false;
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('temporary members of any player retain withdrawn identity, cannot be ignored in use and stay unsaved until adopted', async () => {
  const dir = await dataDir();
  const store = await openStore(dir);
  const f = await household(store);
  try {
    const kitchen = await f.players.create('Kitchen');
    registerSpeaker(f, '11');
    registerSpeaker(f, '12');
    await f.players.join(kitchen.id, '11');
    assertEquals(
      f.outputs.lastCommand()?.selection,
      [
        { id: '11', selected: true },
        { id: '12', selected: false },
      ],
      'exact membership still explicitly cancels transient use of free speakers',
    );
    f.outputs.withdraw('11');
    assertEquals(f.outputs.get('11')?.playerId, kitchen.id);
    await assertRejects(() => f.outputs.ignore('11'), SpeakerError, 'Deselect');
    assertEquals(await store.speakers.loadMemberships(), []);
    await f.players.join(1, '11');
    assertEquals(f.outputs.get('11')?.playerId, 1);
    await f.players.leave(1, '11');
    assertEquals(
      f.outputs.get('11'),
      null,
      'last control reference releases the withdrawn temporary row',
    );
    await f.players.join(kitchen.id, '12');
    await f.outputs.adopt('12');
    assertEquals(
      (await store.speakers.loadMemberships())[0].playerId,
      kitchen.id,
    );
    await f.players.delete(kitchen.id);
    assertEquals(f.players.freeSpeakers().map((row) => row.id), ['12']);
    assertEquals(f.persistence.savedOutput('12')?.playerId, null);
    assertEquals((await store.speakers.loadMemberships())[0].playerId, null);
    assertEquals(f.outputs.lifetime('12').adopted, true);
  } finally {
    await f.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

async function ownToneVolumes() {
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
      await h.players.create('Kitchen');
      for (
        const [id, volume] of [['11', 40], ['12', 20], ['13', 90], [
          '14',
          100,
        ]] as const
      ) {
        registerSpeaker(h, id);
        h.outputs.update(id, { volume });
        await h.outputs.adopt(id);
      }
      await h.players.setSpeakers(1, ['11', '12']);
      await h.players.join(2, '13');
      return {
        library: h.library,
        outputs: h.players.defaultOutputs,
        playback: h.players.playback,
      };
    },
  });
  const origin = `http://melofon.home:${f.extraPorts[0]}`;
  const read = async (path: string) => {
    const response = await fetch(`${origin}/api${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    assertEquals(response.status, 200, await response.clone().text());
    return response.json();
  };
  const put = async (path: string, body?: unknown, status = 204) => {
    const response = await fetch(`${origin}/api${path}`, {
      method: 'PUT',
      headers: { Origin: origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    assertEquals(response.status, status, await response.clone().text());
    if (status === 204) assertEquals(await response.text(), '');
    else await response.body?.cancel();
  };
  return {
    h,
    f,
    read,
    put,
    async close() {
      await h.close();
      await f.close();
    },
  };
}

Deno.test('OwnTone HTTP volume translates the loudest default member and individual output edits', async () => {
  const t = await ownToneVolumes();
  const { h, read, put } = t;
  const levels = async () =>
    (await read('/outputs')).outputs.map((row: { volume: number }) =>
      row.volume
    );
  try {
    const initial = await read('/player');
    assertEquals(
      initial.volume,
      40,
      'not the saved slider, another player or a free output',
    );
    assertEquals(Object.keys(initial).sort(), [
      'consume',
      'item_id',
      'item_length_ms',
      'item_progress_ms',
      'repeat',
      'shuffle',
      'state',
      'volume',
    ]);
    assertEquals(h.players.get(1).playerView().volume, 50);

    await put('/player/volume?volume=60');
    assertEquals(await levels(), [60, 40, 90, 100]);
    assertEquals((await read('/player')).volume, 60);
    assertEquals(
      h.players.get(1).playerView().volume,
      70,
      'move the slider by +20, not to 60',
    );
    assertEquals(
      (await t.f.store.players.list())[0].volume,
      70,
      'response awaits the saved slider',
    );

    await put('/player/volume?volume=50&step=5');
    assertEquals(
      await levels(),
      [50, 30, 90, 100],
      'absolute retains first-valid precedence',
    );
    await put('/player/volume?step=-10');
    assertEquals(await levels(), [40, 20, 90, 100]);
    assertEquals((await read('/player')).volume, 40);
    assertEquals(h.players.get(1).playerView().volume, 50);

    await put('/player/volume?output_id=12&volume=95');
    assertEquals((await read('/outputs/12')).volume, 95);
    assertEquals((await read('/player')).volume, 95);
    await put('/player/volume?output_id=12&step=-5');
    assertEquals(await levels(), [40, 90, 90, 100]);
    assertEquals(
      h.players.get(1).playerView().volume,
      50,
      'individual volume never moves the player',
    );
    await put('/outputs/12', { volume: 85 });
    assertEquals((await read('/player')).volume, 85);
    await put('/player/volume?output_id=13&volume=80');
    await put('/player/volume?output_id=14&volume=99');
    assertEquals(
      (await read('/player')).volume,
      85,
      'unselected edits do not change the master',
    );
    assertEquals(h.outputs.get('13')?.playerId, 2);
    assertEquals(h.players.freeSpeakers().map((row) => row.id), ['14']);

    const before = h.outputs.list(), receipt = h.players.get(1).lastCommand();
    for (
      const query of [
        '',
        '?volume=no',
        '?step=no',
        '?output_id=999&volume=20',
        '?output_id=11',
      ]
    ) {
      await put(`/player/volume${query}`, undefined, 400);
    }
    assertEquals(h.outputs.list(), before);
    assertEquals(h.players.get(1).lastCommand(), receipt);

    await h.players.setDefault(2);
    assertEquals((await read('/player')).volume, 80);
    await put('/player/volume?volume=70');
    assertEquals(await levels(), [40, 85, 70, 99]);
    assertEquals((await read('/player')).volume, 70);
    assertEquals(h.players.get(2).playerView().volume, 40);
    assertEquals(h.players.get(1).playerView().volume, 50);
    assertEquals(h.players.get(2).lastCommand()?.source.kind, 'http');
  } finally {
    await t.close();
  }
});

Deno.test('OwnTone HTTP volume preserves core link, clipping, zero and empty-player semantics', async () => {
  const t = await ownToneVolumes();
  const { h, read, put } = t;
  const levels = async () =>
    (await read('/outputs')).outputs.map((row: { volume: number }) =>
      row.volume
    );
  try {
    await h.players.setLinked(1, '12', false);
    await put('/outputs/12', { volume: 75 });
    assertEquals(
      (await read('/player')).volume,
      75,
      'unlinked members still count toward OwnTone master',
    );
    await put('/player/volume?volume=85');
    assertEquals(await levels(), [50, 75, 90, 100]);
    assertEquals(
      (await read('/player')).volume,
      75,
      'do not move an unlinked member to force the requested master',
    );
    assertEquals(h.players.get(1).playerView().volume, 60);
    await put('/player/volume?volume=0');
    assertEquals(await levels(), [0, 75, 90, 100]);
    assertEquals(h.players.get(1).playerView().volume, 0);
    assertEquals((await read('/player')).volume, 75);
    await h.players.setLinked(1, '12', true);
    await put('/player/volume?volume=0');
    assertEquals(
      await levels(),
      [0, 0, 90, 100],
      'explicit zero still silences at slider zero',
    );
    await put('/player/volume?volume=30');
    assertEquals(await levels(), [30, 30, 90, 100]);
    await put('/player/volume?output_id=11&volume=95');
    await put('/player/volume?step=20');
    assertEquals(
      await levels(),
      [100, 50, 90, 100],
      'speaker clips, balance may break',
    );
    assertEquals((await read('/player')).volume, 100);
    await put('/player/volume?volume=90');
    assertEquals(await levels(), [90, 40, 90, 100]);
    assertEquals(h.players.get(1).playerView().volume, 40);

    await put('/outputs/set', { outputs: [] });
    assertEquals(
      (await read('/player')).volume,
      40,
      'no members uses this player, never unrelated outputs',
    );
    await put('/player/volume?volume=25');
    assertEquals((await read('/player')).volume, 25);
    assertEquals(await levels(), [90, 40, 90, 100]);
    await put('/outputs/12', { selected: true });
    assertEquals(
      (await read('/player')).volume,
      40,
      'joining preserves the absolute speaker number',
    );
    assertEquals(h.players.get(1).playerView().volume, 25);
    await put('/outputs/11/toggle', {});
    assertEquals((await read('/player')).volume, 90);
    assertEquals(h.players.get(1).playerView().volume, 25);
  } finally {
    await t.close();
  }
});

Deno.test('OwnTone HTTP output set, toggle and update operate only on the live default membership', async () => {
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
      const kitchen = await h.players.create('Kitchen');
      for (const id of ['11', '12', '13']) {
        registerSpeaker(h, id);
        await h.outputs.adopt(id);
      }
      await h.players.join(1, '11');
      await h.players.join(kitchen.id, '12');
      await h.players.join(kitchen.id, '13');
      return {
        library: h.library,
        outputs: h.players.defaultOutputs,
        playback: h.players.playback,
      };
    },
  });
  const call = (path: string, body?: unknown) =>
    fetch(`http://melofon.home:${f.extraPorts[0]}/api/outputs${path}`, {
      method: body === undefined ? 'GET' : 'PUT',
      ...(body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      signal: AbortSignal.timeout(5000),
    });
  try {
    const initial = (await (await call('')).json()).outputs;
    assertEquals(initial.map((row: { selected: boolean }) => row.selected), [
      true,
      false,
      false,
    ]);
    assertEquals((await call('/set', { outputs: ['11', '12'] })).status, 204);
    assertEquals(h.players.members(2).map((row) => row.id), ['13']);
    assertEquals((await call('/12/toggle', {})).status, 204);
    assertEquals(h.outputs.get('12')?.playerId, null);
    assertEquals(
      (await call('/13', { selected: false, volume: 23 })).status,
      204,
    );
    assertEquals(h.outputs.get('13')?.playerId, 2);
    assertEquals(h.outputs.get('13')?.volume, 23);
    const volume = await fetch(
      `http://melofon.home:${
        f.extraPorts[0]
      }/api/player/volume?output_id=13&volume=24`,
      { method: 'PUT', signal: AbortSignal.timeout(5000) },
    );
    assertEquals(volume.status, 204);
    assertEquals(h.outputs.get('13')?.volume, 24);
    assertEquals(h.outputs.get('13')?.playerId, 2);
    assertEquals((await call('/13/toggle', {})).status, 204);
    assertEquals(h.outputs.get('13')?.playerId, 1);
    await h.players.setDefault(2);
    assertEquals((await call('/set', { outputs: ['12'] })).status, 204);
    assertEquals(h.players.members(1).map((row) => row.id), ['11', '13']);
    assertEquals(h.players.members(2).map((row) => row.id), ['12']);
    assertEquals((await call('/13', { selected: true })).status, 204);
    assertEquals(h.outputs.get('13')?.playerId, 2);
    assertEquals((await call('/13', { selected: false })).status, 204);
    assertEquals(h.outputs.get('13')?.playerId, null);
    const before = h.outputs.list();
    assertEquals(
      (await call('/set', { outputs: ['11', 'missing'] })).status,
      400,
    );
    assertEquals(h.outputs.list(), before);
    const final = (await (await call('')).json()).outputs;
    assertEquals(final.map((row: { selected: boolean }) => row.selected), [
      false,
      true,
      false,
    ]);
    assertEquals(Object.keys(final[0]).sort(), Object.keys(initial[0]).sort());
    assertEquals(
      (await f.store.speakers.loadMemberships()).map((row) => row.playerId),
      [1, 2, null],
    );
  } finally {
    await h.close();
    await f.close();
  }
});
