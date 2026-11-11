import { assert, assertEquals, assertRejects } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { restored } from './helpers/prepared.ts';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayers } from '../src/players.ts';
import { createPlaybackReports } from '../src/playback-reports.ts';
import { createPersistence } from '../src/persistence.ts';
import { createOutputs } from '../src/player.ts';
import { outputPlayerId } from '../src/player-outputs.ts';
import { createSpeakers } from '../src/speakers.ts';
import { createPlaybackCapacity } from '../src/playback-capacity.ts';
import { PlaybackError } from '../src/playback-errors.ts';
import { createQueueResolver } from '../src/queue-source.ts';
import { createUserService } from '../src/user.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createFolders } from '../src/folders.ts';
import { createQueueExpansion } from '../src/queue-expansion.ts';
import { createPlayback } from '../src/playback.ts';
import { createPlayer } from '../src/player.ts';

async function setup(beforePrepare?: () => Promise<void>) {
  const dir = await restored('api-players', async (dir) => {
    const store = await openStore(dir);
    try {
      await seedFirstUser(store, {
        listen: undefined,
        dataDir: dir,
        user: 'admin',
        password: 'password-admin',
        secret: 'test-secret',
      });
      await createLibraries(store).add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(store);
    } finally {
      await store.close();
    }
  }, 'melofon-api-players-');
  let players!: Awaited<ReturnType<typeof createPlayers>>;
  let reports!: ReturnType<typeof createPlaybackReports>;
  let outputs!: ReturnType<typeof createOutputs>;
  let persistence!: ReturnType<typeof createPersistence>;
  const f = await apiFixture({
    storeDir: dir,
    allLayers: true,
    services: async (f) => {
      const library = createLibrary(f.store);
      const nowPlaying = createNowPlaying(f.store);
      persistence = createPersistence(f.store);
      outputs = createOutputs({ notify: f.notify, persistence });
      const speakers = createSpeakers({
        outputs,
        adapterView: () => ({
          preparation: { state: 'unresolved', targetRevision: 1 },
        }),
        prepare: () => Promise.resolve(true),
      });
      reports = createPlaybackReports({
        nowPlaying,
        library,
        notify: f.notify,
        serverRows: () => players.serverRows(),
      });
      players = await createPlayers({
        store: f.store,
        persistence,
        outputs,
        reports,
        notify: f.notify!,
        clock: { monotonicNow: () => 0 },
        maxResumeAgeMs: 300000,
        capacity: createPlaybackCapacity({
          protocol: 'AirPlay',
          busy: (owner) =>
            new PlaybackError(
              'airplay_busy',
              `AirPlay is busy in ${owner.name}`,
              owner,
            ),
        }),
        playback: {
          library,
          nowPlaying,
          cfg: {},
          state: f.state,
          expandQueueReference: createQueueExpansion({
            library,
            playlists: createPlaylists(f.store),
            folders: createFolders(f.store),
          }),
          resolveQueueReference: createQueueResolver({
            getSong: library.getSong,
            getStation: f.store.radio.get,
          }),
        },
        targets: (id) => ({
          hasPlaybackTarget: () => speakers.hasPlaybackTarget(id),
          preparePlayback: async (signal) => {
            await beforePrepare?.();
            await speakers.preparePlayback(signal, id);
          },
        }),
      });
      return {
        players,
        speakers,
        library,
        playlists: createPlaylists(f.store),
        playback: players.playback,
        user: createUserService(f.store, f.cfg),
        annotation: createAnnotation(f.store),
        listens: createListens(f.store),
      };
    },
  });
  await f.auth.users.create(f.admin.id, {
    username: 'member',
    password: 'password-member',
    role: 'user',
  });
  const songs = await createLibrary(f.store).listSongs({ offset: 0, size: 2 });
  const addSpeaker = async (id: string, type = 'Test', adopted = true) => {
    outputs.register({
      id,
      name: `Speaker ${id}`,
      type,
      selected: false,
      volume: 42,
    });
    if (adopted) await outputs.adopt(id);
  };
  const read = async (path: string, credential: string) => {
    const response = await f.get(path, credential, {
      Origin: 'http://other.home',
    });
    assertEquals(response.status, 200, await response.clone().text());
    assertEquals(response.headers.get('cache-control'), 'no-store');
    return await response.json();
  };
  const command = async (
    path: string,
    method: string,
    credential: string,
    body?: unknown,
    status = 204,
  ) => {
    const response = await f.json(path, method, body, credential);
    assertEquals(response.status, status, await response.clone().text());
    return status === 204
      ? (await response.body?.cancel(), undefined)
      : response.json();
  };
  return {
    f,
    dir,
    players,
    outputs,
    persistence,
    songs,
    addSpeaker,
    read,
    command,
    async close() {
      await players.close();
      await reports.close();
      await persistence.drain();
      await f.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('queue copy HTTP replaces the other queue with new ids, bookmark and modes without touching the playing source', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const home = t.players.get(1);
    const kitchen = await t.players.create('Kitchen');
    const target = t.players.get(kitchen.id);
    await t.addSpeaker('copy-source');
    await t.players.join(1, 'copy-source');
    const entries = await home.queueAdd([t.songs[0], t.songs[1], t.songs[0]], {
      play: true,
    });
    await home.next();
    await home.seek({ positionMs: 300 });
    home.setRepeat('single');
    home.setConsume(true);
    target.setShuffle(true);
    target.setVolume({ volume: 31 });
    await target.queueAdd([t.songs[0]]);
    const before = home.playerView();
    const queue = home.queueView();
    const lease = home.openSource(before.current!.id, before.generation)!;
    const version = target.queueView().version;
    await t.command(
      '/api/v1/players/1/queue/copy/replace',
      'POST',
      credential,
      {
        targetPlayerId: kitchen.id,
        expectedVersion: version,
      },
    );
    const copied = await t.read(
      `/api/v1/players/${kitchen.id}/queue?view=all`,
      credential,
    );
    const state =
      (await t.read(`/api/v1/players/${kitchen.id}`, credential)).player;
    assertEquals(
      copied.items.map((e: { reference: unknown }) => e.reference),
      queue.items.map((e) => e.reference),
    );
    assertEquals(
      new Set([
        ...entries.map((e) => e.id),
        ...copied.items.map((e: { entryId: number }) => e.entryId),
      ]).size,
      6,
    );
    assert(copied.version > version);
    assertEquals([
      state.current.entryId,
      state.positionMs,
      state.repeat,
      state.consume,
      state.state,
      state.shuffle,
    ], [
      copied.items[1].entryId,
      before.itemProgressMs,
      'single',
      true,
      'pause',
      true,
    ]);
    assertEquals(target.playerView().volume, 31);
    assertEquals(home.playerView(), before);
    assertEquals(home.queueView(), queue);
    assert(!lease.signal.aborted);
    for (const playback of [home, target]) {
      assertEquals(playback.lastCommand()!.kind, 'queueCopy');
      assertEquals(playback.lastCommand()!.source.user, 'member');
      assertEquals(playback.serverNowPlayingView()!.commander, 'member');
    }
    await t.persistence.drain();
    assertEquals(
      (await t.f.store.playback.loadQueue(1)).items.map((e) => e.id),
      entries.map((e) => e.id),
    );
    const saved = await t.f.store.playback.loadQueue(kitchen.id);
    const bookmark = await t.f.store.playback.loadPlayerState(kitchen.id);
    assertEquals(
      saved.items.map((e) => e.id),
      copied.items.map((e: { entryId: number }) => e.entryId),
    );
    assertEquals([
      bookmark!.currentIndex,
      bookmark!.positionMs,
      bookmark!.repeat,
      bookmark!.consume,
    ], [1, before.itemProgressMs, 'single', true]);
  } finally {
    await t.close();
  }
});

Deno.test('queue copy HTTP replace preserves destination play or pause, starts on request and handles stopped and empty sources', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    const home = t.players.get(1);
    const kitchen = await t.players.create('Kitchen');
    const target = t.players.get(kitchen.id);
    for (
      const [id, name] of [[1, 'copy-from'], [kitchen.id, 'copy-to']] as const
    ) {
      await t.addSpeaker(name);
      await t.players.join(id, name);
    }
    await home.queueAdd(t.songs, { play: true });
    await home.next();
    await home.seek({ positionMs: 200 });
    home.pause();
    await target.queueAdd(t.songs, { play: true });
    const path = '/api/v1/players/1/queue/copy/replace';
    for (
      const [paused, startPlaying] of [[false, false], [true, false], [
        true,
        true,
      ]]
    ) {
      if (paused) target.pause();
      const old = target.playerView();
      const lease = paused
        ? null
        : target.openSource(old.current!.id, old.generation);
      await t.command(path, 'POST', credential, {
        targetPlayerId: kitchen.id,
        startPlaying,
      });
      const state =
        (await t.read(`/api/v1/players/${kitchen.id}`, credential)).player;
      assertEquals([state.state, state.positionMs, state.current.song.id], [
        startPlaying || !paused ? 'play' : 'pause',
        200,
        t.songs[1].id,
      ]);
      if (lease) assert(lease.signal.aborted);
      assertEquals(home.playerView().state, 'pause');
    }
    home.queueClear();
    await home.queueAdd(t.songs);
    await t.command(path, 'POST', credential, { targetPlayerId: kitchen.id });
    assertEquals([
      target.playerView().state,
      target.playerView().current!.reference,
    ], ['play', { kind: 'song', id: t.songs[0].id }]);
    target.stop();
    await t.command(path, 'POST', credential, { targetPlayerId: kitchen.id });
    assertEquals([target.playerView().state, target.playerView().current], [
      'stop',
      null,
    ]);
    home.queueClear();
    await t.command(path, 'POST', credential, {
      targetPlayerId: kitchen.id,
      startPlaying: true,
    });
    assertEquals(target.queueView().items, []);
    assertEquals([target.playerView().state, target.playerView().current], [
      'stop',
      null,
    ]);
  } finally {
    await t.close();
  }
});

Deno.test('queue copy HTTP adds the whole ordered queue at end, next or position preserving destination state unless starting', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const home = t.players.get(1);
    const kitchen = await t.players.create('Kitchen');
    const target = t.players.get(kitchen.id);
    await home.queueAddSources([
      {
        reference: { kind: 'url', url: 'http://radio.home/live' },
        facts: {
          kind: 'web',
          url: 'http://radio.home/live',
          mode: 'live',
          seekable: false,
          title: 'Radio',
          artistName: null,
          durationMs: null,
          streamTitle: null,
          streamUrl: null,
        },
      },
    ]);
    await home.queueAdd([t.songs[1], t.songs[1]]);
    home.setRepeat('single');
    home.setConsume(true);
    const sourceQueue = home.queueView();
    const sourceState = home.playerView();
    await t.addSpeaker('copy-add');
    await t.players.join(kitchen.id, 'copy-add');
    const path = '/api/v1/players/1/queue/copy/add';
    for (
      const [where, at] of [['end', 2], ['next', 1], [{ position: 0 }, 0], [{
        position: 999,
      }, 2]] as const
    ) {
      const old = await target.queueAdd(t.songs, { clear: true, play: true });
      const state = target.playerView();
      const lease = target.openSource(state.current!.id, state.generation)!;
      await t.command(path, 'POST', credential, {
        targetPlayerId: kitchen.id,
        where,
      });
      const queue = await t.read(
        `/api/v1/players/${kitchen.id}/queue?view=all`,
        credential,
      );
      const expected = [
        ...old.slice(0, at),
        ...sourceQueue.items,
        ...old.slice(at),
      ];
      assertEquals(
        queue.items.map((e: { reference: unknown }) => e.reference),
        expected.map((e) => e.reference),
      );
      assertEquals(target.playerView(), state);
      assert(!lease.signal.aborted);
      assertEquals([target.playerView().repeat, target.playerView().consume], [
        'off',
        false,
      ]);
      assertEquals(
        new Set(queue.items.map((e: { entryId: number }) => e.entryId)).size,
        5,
      );
    }
    await t.command(path, 'POST', credential, {
      targetPlayerId: kitchen.id,
      where: { position: 2 },
      startPlaying: true,
    });
    const addedState =
      (await t.read(`/api/v1/players/${kitchen.id}`, credential)).player;
    assertEquals([
      addedState.state,
      addedState.current.media.kind,
      addedState.positionMs,
    ], ['play', 'web', 0]);
    assertEquals(
      target.playerView().current!.id,
      target.queueView().items[2].id,
    );
    assertEquals(home.queueView(), sourceQueue);
    assertEquals(home.playerView(), sourceState);
    await t.persistence.drain();
    assertEquals(
      (await t.f.store.playback.loadQueue(kitchen.id)).items.length,
      8,
    );
  } finally {
    await t.close();
  }
});

Deno.test('queue copy HTTP refuses limit, stale version, no target and busy AirPlay before either player changes', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    const home = t.players.get(1);
    const kitchen = await t.players.create('Kitchen');
    const target = t.players.get(kitchen.id);
    await home.queueAdd(t.songs);
    await target.queueAdd(t.songs);
    await t.f.state.set('playback.queueLimit', '3');
    const unchanged = async (
      mode: string,
      body: Record<string, unknown>,
      code: string,
    ) => {
      const before = [
        home.queueView(),
        target.queueView(),
        home.playerView(),
        target.playerView(),
        home.lastCommand(),
        target.lastCommand(),
      ];
      const response = await t.f.json(
        `/api/v1/players/1/queue/copy/${mode}`,
        'POST',
        { targetPlayerId: kitchen.id, ...body },
        credential,
      );
      assertEquals(response.status, 409);
      const reply = await response.json();
      assertEquals(reply.code, code);
      if (code === 'queue_limit') assertEquals(reply.limit, 3);
      if (code === 'queue_conflict') {
        assertEquals(reply.version, target.queueView().version);
      }
      if (code === 'airplay_busy') {
        assertEquals(reply.owner, { id: 1, name: 'Home' });
      }
      assertEquals([
        home.queueView(),
        target.queueView(),
        home.playerView(),
        target.playerView(),
        home.lastCommand(),
        target.lastCommand(),
      ], before);
    };
    await unchanged('add', {}, 'queue_limit');
    await unchanged('replace', { expectedVersion: 999 }, 'queue_conflict');
    await unchanged('replace', { startPlaying: true }, 'no_target');
    await t.f.state.set('playback.queueLimit', '10');
    for (
      const [id, name] of [[1, 'air-from'], [kitchen.id, 'air-to']] as const
    ) {
      await t.addSpeaker(name, 'AirPlay');
      await t.players.join(id, name);
    }
    await home.play();
    const old = home.playerView();
    const lease = home.openSource(old.current!.id, old.generation)!;
    for (const mode of ['replace', 'add']) {
      await unchanged(mode, { startPlaying: true }, 'airplay_busy');
    }
    assert(!lease.signal.aborted);
    await t.command(
      '/api/v1/players/1/queue/copy/replace',
      'POST',
      credential,
      { targetPlayerId: kitchen.id },
    );
    assertEquals(home.playerView(), old);
    assertEquals(target.playerView().state, 'pause');
    assert(!lease.signal.aborted);
    await home.queueAdd(t.songs);
    await t.f.state.set('playback.queueLimit', '3');
    await unchanged('replace', {}, 'queue_limit');
  } finally {
    await t.close();
  }
});

Deno.test('queue copy HTTP validates both actions, authentication, Origin and target identity without mutation', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    const kitchen = await t.players.create('Kitchen');
    const home = t.players.get(1);
    const target = t.players.get(kitchen.id);
    await home.queueAdd(t.songs);
    const before = [
      home.queueView(),
      target.queueView(),
      home.lastCommand(),
      target.lastCommand(),
    ];
    for (const mode of ['replace', 'add']) {
      const path = `/api/v1/players/1/queue/copy/${mode}`;
      for (
        const body of [
          {},
          { targetPlayerId: '2' },
          { targetPlayerId: 0 },
          { targetPlayerId: 2.5 },
          { targetPlayerId: null },
          { targetPlayerId: kitchen.id, startPlaying: 1 },
          { targetPlayerId: kitchen.id, expectedVersion: -1 },
          { targetPlayerId: kitchen.id, expectedVersion: '1' },
          { targetPlayerId: kitchen.id, extra: true },
        ]
      ) {
        const response = await t.f.json(path, 'POST', body, credential);
        assertEquals(response.status, 400, await response.clone().text());
        await response.body?.cancel();
      }
      await error(
        await t.f.json(path, 'POST', { targetPlayerId: 1 }, credential),
        400,
        'same_player',
      );
      await error(
        await t.f.json(path, 'POST', { targetPlayerId: 999 }, credential),
        404,
        'not_found',
      );
      await error(
        await t.f.json(path.replace('/1/', '/999/'), 'POST', {
          targetPlayerId: kitchen.id,
        }, credential),
        404,
        'not_found',
      );
      await error(
        await t.f.json(path, 'POST', { targetPlayerId: kitchen.id }),
        401,
        'unauthenticated',
      );
      const foreign = await t.f.json(
        path,
        'POST',
        { targetPlayerId: kitchen.id },
        credential,
        'http://foreign.home',
      );
      assertEquals(foreign.status, 403);
      await foreign.body?.cancel();
    }
    for (
      const where of ['bad', -1, { position: -1 }, { position: '0' }, {
        position: 1,
        extra: true,
      }]
    ) {
      const response = await t.f.json(
        '/api/v1/players/1/queue/copy/add',
        'POST',
        { targetPlayerId: kitchen.id, where },
        credential,
      );
      assertEquals(response.status, 400);
      await response.body?.cancel();
    }
    const response = await t.f.json(
      '/api/v1/players/1/queue/copy/replace',
      'POST',
      { targetPlayerId: kitchen.id, where: 'end' },
      credential,
    );
    await error(response, 400, 'unknown_field');
    assertEquals([
      home.queueView(),
      target.queueView(),
      home.lastCommand(),
      target.lastCommand(),
    ], before);
    const copied = await t.f.json(
      '/_melofon/api/v1/players/1/queue/copy/add',
      'POST',
      { targetPlayerId: kitchen.id },
      credential,
    );
    assertEquals(copied.status, 204, await copied.text());
  } finally {
    await t.close();
  }
});

Deno.test('queue copy HTTP snapshots source without cancelling it and rejects stale destination after slow preparation', async () => {
  let release!: () => void, entered!: () => void;
  let barrier: Promise<void> | undefined;
  const t = await setup(async () => {
    if (barrier) {
      entered();
      await barrier;
    }
  });
  try {
    const { credential } = await t.f.login('bearer');
    const kitchen = await t.players.create('Kitchen');
    const home = t.players.get(1), target = t.players.get(kitchen.id);
    await t.addSpeaker('snapshot-from');
    await t.players.join(1, 'snapshot-from');
    await t.addSpeaker('snapshot-to');
    await t.players.join(kitchen.id, 'snapshot-to');
    const media = {
      reference: { kind: 'url' as const, url: 'http://radio.home/live' },
      facts: {
        kind: 'web' as const,
        url: 'http://radio.home/live',
        mode: 'live' as const,
        seekable: false,
        title: 'Live',
        artistName: null,
        durationMs: null,
        streamTitle: null,
        streamUrl: null,
      },
    };
    await home.queueAddSources([media], { play: true });
    await target.queueAddSources([media], { play: true });
    const oldSource = home.playerView();
    const fromLease = home.openSource(
      oldSource.current!.id,
      oldSource.generation,
    )!;
    const oldTarget = target.playerView();
    const toLease = target.openSource(
      oldTarget.current!.id,
      oldTarget.generation,
    )!;
    const last = [home.lastCommand(), target.lastCommand()];
    const ready = new Promise<void>((done) => entered = done);
    barrier = new Promise<void>((done) => release = done);
    const response = t.f.json('/api/v1/players/1/queue/copy/replace', 'POST', {
      targetPlayerId: kitchen.id,
      expectedVersion: target.queueView().version,
    }, credential);
    await ready;
    assert(
      home.reportSourceMetadata(fromLease, { streamTitle: 'New source title' }),
    );
    assert(
      target.reportSourceMetadata(toLease, {
        streamTitle: 'New destination title',
      }),
    );
    release();
    barrier = undefined;
    const conflict = await response;
    assertEquals(conflict.status, 409);
    assertEquals((await conflict.json()).code, 'queue_conflict');
    assertEquals([home.lastCommand(), target.lastCommand()], last);
    assertEquals(target.playerView().current!.id, oldTarget.current!.id);
    assert(!fromLease.signal.aborted);
    assert(!toLease.signal.aborted);
    await t.command('/api/v1/players/1/queue/copy/add', 'POST', credential, {
      targetPlayerId: kitchen.id,
    });
    assert(!fromLease.signal.aborted);
    assert(!toLease.signal.aborted);
    home.reportSourceMetadata(fromLease, { streamTitle: 'Later source title' });
    const copied = target.queueView().items[1];
    assert(copied.facts.kind === 'web');
    assertEquals(copied.facts.streamTitle, 'New source title');
    const copying = new Promise<void>((done) => entered = done);
    barrier = new Promise<void>((done) => release = done);
    const success = t.f.json('/api/v1/players/1/queue/copy/replace', 'POST', {
      targetPlayerId: kitchen.id,
    }, credential);
    await copying;
    assert(
      home.reportSourceMetadata(fromLease, {
        streamTitle: 'Changed during copy',
      }),
    );
    release();
    barrier = undefined;
    const done = await success;
    assertEquals(done.status, 204, await done.text());
    const detached = target.queueView().items[0];
    assert(detached.facts.kind === 'web');
    assertEquals(detached.facts.streamTitle, 'Later source title');
    assert(!fromLease.signal.aborted);
    assert(toLease.signal.aborted);
  } finally {
    release?.();
    await t.close();
  }
});

Deno.test('queue copy HTTP saves both command receipts and destination bookmark/queue in one retryable transaction', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    const kitchen = await t.players.create('Kitchen');
    const home = t.players.get(1), target = t.players.get(kitchen.id);
    await home.queueAdd(t.songs);
    await target.queueAdd([t.songs[0]]);
    await t.persistence.drain();
    const savedBefore = await t.f.store.playback.loadQueue(kitchen.id);
    const commandsBefore = (await t.f.store.players.list()).map((p) =>
      p.commandedAtMs
    );
    const saveChanges = t.f.store.players.saveChanges;
    const batches: Parameters<typeof saveChanges>[0][] = [];
    let failOnce = true;
    t.f.store.players.saveChanges = async (changes) => {
      batches.push(structuredClone(changes));
      if (failOnce) {
        failOnce = false;
        throw new Error('copy transaction write unavailable');
      }
      await saveChanges(changes);
    };
    const response = await t.f.json(
      '/api/v1/players/1/queue/copy/replace',
      'POST',
      { targetPlayerId: kitchen.id },
      credential,
    );
    assertEquals(response.status, 500);
    await response.body?.cancel();
    const failedSave = await t.f.store.playback.loadQueue(kitchen.id);
    assertEquals(failedSave.items, savedBefore.items);
    assertEquals(failedSave.version, savedBefore.version);
    // Household ids are reserved before publication and never reused, even
    // when the later multi-player transaction must be retried.
    assertEquals(
      failedSave.nextId,
      Math.max(...target.queueView().items.map((e) => e.id)) + 1,
    );
    assert(failedSave.nextId > savedBefore.nextId);
    assertEquals(
      (await t.f.store.players.list()).map((p) => p.commandedAtMs),
      commandsBefore,
    );
    assertEquals(batches.length, 1);
    const batch = batches[0].players!;
    assertEquals(batch.map((p) => p.playerId).sort(), [1, kitchen.id]);
    assert(batch.every((p) => p.commandedAtMs !== undefined && p.state));
    assert(batch.find((p) => p.playerId === kitchen.id)!.queue);
    assertEquals(batch.find((p) => p.playerId === 1)!.queue, undefined);
    await t.persistence.drain();
    assertEquals(batches.length, 2);
    assertEquals(batches[1], batches[0]);
    assertEquals(
      (await t.f.store.playback.loadQueue(kitchen.id)).items.map((e) => e.id),
      target.queueView().items.map((e) => e.id),
    );
    assertEquals((await t.f.store.players.list()).map((p) => p.commandedAtMs), [
      home.lastCommand()!.atMs,
      target.lastCommand()!.atMs,
    ]);
  } finally {
    await t.close();
  }
});

Deno.test('queue edit HTTP moves permanent occurrences without interrupting current audio and persists final positions', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const home = t.players.get(1);
    const other = await t.players.create('Kitchen');
    await t.players.get(other.id).queueAdd([t.songs[0]]);
    const otherBefore = t.players.get(other.id).queueView();
    await t.addSpeaker('edit-target');
    await t.players.join(1, 'edit-target');
    const entries = await home.queueAdd([
      t.songs[0],
      t.songs[0],
      t.songs[1],
      t.songs[0],
    ], { play: true });
    await home.seek({ positionMs: 4000 });
    const before = home.playerView();
    const lease = home.openSource(entries[0].id, before.generation)!;
    assert(lease);
    const path = '/api/v1/players/1/queue/items';
    await t.command(`${path}/${entries[0].id}`, 'PATCH', credential, {
      position: 2,
      expectedVersion: home.queueView().version,
    });
    assertEquals(home.queueView().items.map((e) => e.id), [
      entries[1].id,
      entries[2].id,
      entries[0].id,
      entries[3].id,
    ]);
    assertEquals(home.playerView(), before);
    assert(!lease.signal.aborted);
    await t.command(`${path}/${entries[3].id}`, 'PATCH', credential, {
      position: 0,
    });
    await t.command(`${path}/${entries[1].id}`, 'PATCH', credential, {
      position: 999,
    });
    assertEquals(home.queueView().items.map((e) => e.id), [
      entries[3].id,
      entries[2].id,
      entries[0].id,
      entries[1].id,
    ]);
    await t.command(`${path}/${entries[3].id}`, 'DELETE', credential);
    await t.command(`${path}/${entries[1].id}`, 'DELETE', credential);
    assertEquals(home.playerView(), before);
    assert(!lease.signal.aborted);
    assertEquals(home.lastCommand()?.source.user, 'member');
    assertEquals(t.players.get(other.id).queueView(), otherBefore);
    await t.persistence.drain();
    const saved = await t.f.store.playback.loadQueue(1);
    assertEquals(saved.items.map((e) => e.id), [entries[2].id, entries[0].id]);
    assertEquals(saved.version, home.queueView().version);
    const state = await t.f.store.playback.loadPlayerState(1);
    assert(before.itemProgressMs > 0);
    assertEquals([state!.currentIndex, state!.positionMs], [
      1,
      before.itemProgressMs,
    ]);
  } finally {
    await t.close();
  }
});

Deno.test('queue edit HTTP removes current into its successor preserving play or pause and stops at the end', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    const home = t.players.get(1);
    await t.addSpeaker('remove-target');
    await t.players.join(1, 'remove-target');
    const path = '/api/v1/players/1';
    for (const paused of [false, true]) {
      const entries = await home.queueAdd(
        [t.songs[0], t.songs[0], t.songs[1]],
        { clear: true, play: true },
      );
      home.setRepeat('single');
      home.setConsume(true);
      await home.seek({ positionMs: 5000 });
      if (paused) home.pause();
      const old = home.playerView();
      const lease = paused
        ? null
        : home.openSource(entries[0].id, old.generation);
      await t.command(
        `${path}/queue/items/${
          entries[0].id
        }?expectedVersion=${home.queueView().version}`,
        'DELETE',
        credential,
      );
      const state = (await t.read(path, credential)).player;
      assertEquals([
        state.current.entryId,
        state.positionMs,
        state.state,
        state.repeat,
        state.consume,
      ], [entries[1].id, 0, paused ? 'pause' : 'play', 'single', true]);
      if (lease) assert(lease.signal.aborted);
      await t.command(
        `${path}/queue/items/${entries[1].id}`,
        'DELETE',
        credential,
      );
      assertEquals(home.playerView().current!.id, entries[2].id);
      await t.command(
        `${path}/queue/items/${entries[2].id}`,
        'DELETE',
        credential,
      );
      assertEquals([
        home.playerView().state,
        home.playerView().current,
        home.playerView().itemProgressMs,
      ], ['stop', null, 0]);
    }
    const entries = await home.queueAdd(t.songs, { play: true });
    await home.play();
    await home.next();
    await t.command(
      `${path}/queue/items/${entries[1].id}`,
      'DELETE',
      credential,
    );
    assertEquals(
      home.playerView().state,
      'stop',
      'removing the tail never wraps even under repeat',
    );
    assertEquals(home.queueView().items.map((e) => e.id), [entries[0].id]);
    await t.command(`${path}/queue`, 'DELETE', credential);
    assertEquals(home.queueView().items, []);
    await t.persistence.drain();
    assertEquals((await t.f.store.playback.loadQueue(1)).items, []);
  } finally {
    await t.close();
  }
});

Deno.test('queue edit HTTP refuses stale versions before mutation or provenance and reports the current version', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    const home = t.players.get(1);
    const [entry] = await home.queueAdd(t.songs);
    const stale = home.queueView().version;
    await home.queueAdd(t.songs);
    const before = home.queueView();
    const last = home.lastCommand();
    const path = '/api/v1/players/1/queue';
    for (
      const [url, method, body] of [
        [`${path}/items/${entry.id}`, 'PATCH', {
          position: 1,
          expectedVersion: stale,
        }],
        [
          `${path}/items/${entry.id}?expectedVersion=${stale}`,
          'DELETE',
          undefined,
        ],
        [`${path}?expectedVersion=${stale}`, 'DELETE', undefined],
      ] as const
    ) {
      const response = await t.f.json(url, method, body, credential);
      assertEquals(response.status, 409);
      assertEquals(await response.json(), {
        code: 'queue_conflict',
        message: 'Queue version has changed',
        version: before.version,
      });
      assertEquals(home.queueView(), before);
      assertEquals(home.lastCommand(), last);
    }
    await t.command(`${path}/items/${entry.id}`, 'PATCH', credential, {
      position: 1,
      expectedVersion: before.version,
    });
    await t.command(
      `${path}?expectedVersion=${home.queueView().version}`,
      'DELETE',
      credential,
    );
    assertEquals(home.playerView().state, 'stop');
    assert(home.queueView().version > before.version);
  } finally {
    await t.close();
  }
});

Deno.test('queue edit HTTP validates ids, positions, versions, Origin and authentication without changing either player', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const home = t.players.get(1);
    const [entry] = await home.queueAdd(t.songs);
    const other = await t.players.create('Kitchen');
    const [foreign] = await t.players.get(other.id).queueAdd(t.songs);
    const before = home.queueView();
    const path = '/api/v1/players/1/queue';
    for (
      const body of [
        {},
        { position: -1 },
        { position: 1.5 },
        { position: '1' },
        { position: 0, expectedVersion: -1 },
        { position: 0, expectedVersion: null },
        { position: 0, expectedVersion: '1' },
        { position: 0, extra: true },
      ]
    ) {
      const response = await t.f.json(
        `${path}/items/${entry.id}`,
        'PATCH',
        body,
        credential,
      );
      assertEquals(response.status, 400, await response.clone().text());
      await response.body?.cancel();
    }
    for (
      const query of [
        'expectedVersion=-1',
        'expectedVersion=1.2',
        'expectedVersion=x',
        'expectedVersion=9007199254740992',
        'expectedVersion=1&expectedVersion=2',
        'extra=1',
      ]
    ) {
      for (const url of [path, `${path}/items/${entry.id}`]) {
        const response = await t.f.json(
          `${url}?${query}`,
          'DELETE',
          undefined,
          credential,
        );
        assertEquals(response.status, 400, await response.clone().text());
        await response.body?.cancel();
      }
    }
    for (
      const id of [
        '0',
        '01',
        '-1',
        'bad',
        '9007199254740992',
        String(foreign.id),
      ]
    ) {
      for (const method of ['DELETE', 'PATCH']) {
        const response = await t.f.json(
          `${path}/items/${id}`,
          method,
          method === 'PATCH' ? { position: 0 } : undefined,
          credential,
        );
        assertEquals(response.status, 404, await response.clone().text());
        await response.body?.cancel();
      }
    }
    for (const url of [path, `${path}/items/${entry.id}`]) {
      await error(
        await t.f.json(url, 'DELETE', undefined),
        401,
        'unauthenticated',
      );
      await error(
        await t.f.json(
          url,
          'DELETE',
          undefined,
          credential,
          'http://other.home',
        ),
        403,
        'origin',
      );
    }
    assertEquals(home.queueView(), before);
    const missing = await t.f.json(
      '/api/v1/players/999/queue',
      'DELETE',
      undefined,
      credential,
    );
    assertEquals(missing.status, 404);
    await missing.body?.cancel();
    const rebased = await t.f.json(
      `/_melofon/api/v1/players/1/queue/items/${entry.id}`,
      'PATCH',
      { position: 1 },
      credential,
    );
    assertEquals(rebased.status, 204);
    await rebased.body?.cancel();
  } finally {
    await t.close();
  }
});

Deno.test('queue edit HTTP rechecks the expected version after slow successor preparation', async () => {
  let hold = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const t = await setup(async () => {
    if (!hold) return;
    entered.resolve();
    await release.promise;
  });
  try {
    const { credential } = await t.f.login('bearer');
    await t.addSpeaker('slow-remove');
    await t.players.join(1, 'slow-remove');
    const home = t.players.get(1);
    const resolver = createQueueResolver({
      getSong: () => Promise.resolve(null),
      getStation: () => Promise.resolve(null),
    });
    const media =
      (await resolver({ kind: 'url', url: 'http://radio.home/live' }))!;
    assert(media.facts.kind === 'web');
    media.facts.mode = 'live';
    const entries = await home.queueAddSources([media, media], { play: true });
    const lease = home.openSource(entries[0].id, home.playerView().generation)!;
    const expected = home.queueView().version;
    const last = home.lastCommand();
    hold = true;
    const pending = t.f.json(
      `/api/v1/players/1/queue/items/${
        entries[0].id
      }?expectedVersion=${expected}`,
      'DELETE',
      undefined,
      credential,
    );
    await entered.promise;
    assert(home.reportSourceMetadata(lease, { streamTitle: 'New broadcast' }));
    const before = home.queueView();
    release.resolve();
    const response = await pending;
    assertEquals(response.status, 409);
    const conflict = await response.json();
    assertEquals([conflict.code, conflict.version], [
      'queue_conflict',
      before.version,
    ]);
    assertEquals(home.queueView(), before);
    assertEquals(home.lastCommand(), last);
    assertEquals(home.playerView().current!.id, entries[0].id);
    assert(!lease.signal.aborted);
  } finally {
    release.resolve();
    await t.close();
  }
});

Deno.test('queue add HTTP expands every reference in order, preserving duplicates and leaf identities', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const library = createLibrary(t.f.store);
    const playlists = createPlaylists(t.f.store);
    const album = (await library.getAlbum(t.songs[0].albumId!))!;
    const artistId = (await library.listArtists())[0].id;
    const artistAlbums = await library.albumsByArtist(artistId);
    const artistSongs = (await Promise.all(artistAlbums.map((a) =>
      library.getAlbum(a.id)
    )))
      .flatMap((a) => a!.songs.map((s) => s.id));
    const own = await playlists.create('member', 'My queue', [
      t.songs[1].id,
      t.songs[0].id,
      t.songs[1].id,
    ]);
    const station = await t.f.store.radio.create({
      name: 'Local station',
      streamUrl: 'http://melofon.home/radio',
      homePageUrl: null,
    });
    const root = (await createLibraries(t.f.store).list())[0];
    const folder = {
      kind: 'folder',
      libraryId: root.id,
      path: 'Fixture Artist/Fixture Album',
    };
    const folderSongs = (await createFolders(t.f.store).browse({
      ...folder,
      folders: { offset: 0, limit: 10 },
      songs: { offset: 0, limit: 10 },
    })).songs.rows;
    const cases = [
      { reference: { kind: 'song', id: t.songs[0].id }, ids: [t.songs[0].id] },
      {
        reference: { kind: 'album', id: album.album.id },
        ids: album.songs.map((s) => s.id),
      },
      { reference: { kind: 'artist', id: artistId }, ids: artistSongs },
      { reference: folder, ids: folderSongs.map((s) => s.id) },
      { reference: { kind: 'playlist', id: own.id }, ids: own.trackIds },
    ];
    for (const { reference, ids } of cases) {
      const result = await t.command(
        '/api/v1/players/1/queue/items',
        'POST',
        credential,
        { references: [reference], clear: true },
        200,
      );
      assertEquals(result.count, ids.length);
      assertEquals(
        result.items.map((e: { reference: unknown }) => e.reference),
        ids.map((id) => ({ kind: 'song', id })),
      );
      const page = await t.read('/api/v1/players/1/queue?view=all', credential);
      assertEquals(page.items, result.items);
      assertEquals(page.version, result.version);
    }
    const url = 'http://melofon.home/announcement';
    const result = await t.command(
      '/api/v1/players/1/queue/items',
      'POST',
      credential,
      {
        clear: true,
        references: [
          { kind: 'song', id: t.songs[0].id },
          { kind: 'station', id: station.id },
          { kind: 'url', url },
          { kind: 'song', id: t.songs[0].id },
        ],
      },
      200,
    );
    assertEquals(result.count, 4);
    assertEquals(
      result.items.map((e: { reference: { kind: string } }) =>
        e.reference.kind
      ),
      ['song', 'station', 'url', 'song'],
    );
    assertEquals(
      new Set(result.items.map((e: { entryId: number }) => e.entryId)).size,
      4,
    );
    assertEquals(result.items[1].media.title, 'Local station');
    assertEquals(result.items[2].reference, { kind: 'url', url });
    const home = t.players.get(1);
    assertEquals(home.lastCommand()?.source.user, 'member');
    assertEquals(home.lastCommand()?.source.via, 'melofon');
    await t.persistence.drain();
    assertEquals(
      (await t.f.store.playback.loadQueue(1)).items.map((e) => e.reference),
      result.items.map((e: { reference: unknown }) => e.reference),
    );
  } finally {
    await t.close();
  }
});

Deno.test('queue add HTTP resolves end, next and positions on the server and starts the first added song', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const path = '/api/v1/players/1';
    const home = t.players.get(1);
    const other = await t.players.create('Kitchen');
    await t.players.get(other.id).queueAdd([t.songs[1]]);
    const otherBefore = t.players.get(other.id).queueView();
    await t.addSpeaker('add-target');
    await t.players.join(1, 'add-target');
    const add = (body: unknown) =>
      t.command(`${path}/queue/items`, 'POST', credential, body, 200);
    const refs = (index: number) => [{ kind: 'song', id: t.songs[index].id }];
    await add({ references: [...refs(0), ...refs(1)], startPlaying: true });
    const original = home.playerView().current!.id;
    const next = await add({ references: refs(1), where: 'next' });
    assertEquals(next.items[0].position, 1);
    assertEquals(home.playerView().current!.id, original);
    assertEquals(home.playerView().state, 'play');
    const inserted = await add({ references: refs(0), where: { position: 0 } });
    assertEquals(inserted.items[0].position, 0);
    assertEquals(home.playerView().current!.id, original);
    const end = await add({
      references: refs(1),
      where: { position: 999 },
      startPlaying: true,
    });
    assertEquals(end.items[0].position, 4);
    assertEquals(home.playerView().current!.id, end.items[0].entryId);
    await t.command(`${path}/pause`, 'POST', credential, {});
    const append = await add({ references: refs(0), where: 'end' });
    assertEquals(append.items[0].position, 5);
    assertEquals(home.playerView().state, 'pause');
    assertEquals(home.playerView().current!.id, end.items[0].entryId);
    const fresh = await add({
      references: [...refs(1), ...refs(0)],
      where: 'next',
      clear: true,
      startPlaying: true,
    });
    assertEquals(fresh.items.map((e: { position: number }) => e.position), [
      0,
      1,
    ]);
    assertEquals(home.playerView().current!.id, fresh.items[0].entryId);
    assertEquals(home.playerView().state, 'play');
    assertEquals(t.players.get(other.id).queueView(), otherBefore);
    await t.command(`${path}/stop`, 'POST', credential, {});
    home.queueClear();
    const noCurrent = await add({ references: refs(0), where: 'next' });
    assertEquals(noCurrent.items[0].position, 0);
    assertEquals(home.playerView().state, 'stop');
  } finally {
    await t.close();
  }
});

Deno.test('queue add HTTP uses caller playlist visibility and refuses entire unresolved batches before clear or play', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const playlists = createPlaylists(t.f.store);
    const privateList = await playlists.create('admin', 'Private', [
      t.songs[1].id,
    ]);
    const publicList = await playlists.create('admin', 'Public', [
      t.songs[1].id,
    ], true);
    const home = t.players.get(1);
    await home.queueAdd(t.songs);
    const before = home.queueView();
    const last = home.lastCommand();
    const failReferences = [
      { kind: 'playlist', id: privateList.id },
      ...['song', 'album', 'artist', 'playlist', 'station'].map((kind) => ({
        kind,
        id: 'missing',
      })),
      {
        kind: 'folder',
        libraryId: (await createLibraries(t.f.store).list())[0].id,
        path: 'missing',
      },
    ];
    for (const reference of failReferences) {
      const response = await t.f.json('/api/v1/players/1/queue/items', 'POST', {
        references: [{ kind: 'song', id: t.songs[0].id }, reference],
        clear: true,
        startPlaying: true,
      }, credential);
      assertEquals(response.status, 404, await response.clone().text());
      await response.body?.cancel();
      assertEquals(home.queueView(), before);
      assertEquals(home.lastCommand(), last);
    }
    const result = await t.command(
      '/api/v1/players/1/queue/items',
      'POST',
      credential,
      {
        references: [{ kind: 'playlist', id: publicList.id }],
        clear: true,
      },
      200,
    );
    assertEquals(result.items[0].reference.id, t.songs[1].id);
  } finally {
    await t.close();
  }
});

Deno.test('queue add HTTP recursively expands canonical folders without filesystem path access', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('cookie');
    const root = (await createLibraries(t.f.store).list())[0];
    const all = await createLibrary(t.f.store).listSongs({
      offset: 0,
      size: 100,
    });
    const result = await t.command(
      '/api/v1/players/1/queue/items',
      'POST',
      credential,
      {
        references: [{ kind: 'folder', libraryId: root.id, path: '' }],
      },
      200,
    );
    assertEquals(result.count, all.length);
    assertEquals(
      result.items.map((e: { reference: { id: string } }) => e.reference.id)
        .sort(),
      all.map((s) => s.id).sort(),
    );
    const before = t.players.get(1).queueView();
    for (
      const path of [
        '../',
        '/etc',
        'Fixture Artist/../Various Artists',
        'Fixture Artist//Fixture Album',
        'C:\\Music',
      ]
    ) {
      await error(
        await t.f.json('/api/v1/players/1/queue/items', 'POST', {
          references: [{ kind: 'folder', libraryId: root.id, path }],
          clear: true,
        }, credential),
        400,
        'invalid_field',
      );
      assertEquals(t.players.get(1).queueView(), before);
    }
  } finally {
    await t.close();
  }
});

Deno.test('queue add HTTP enforces a live per-player limit atomically on every core add port and clear-first sizing', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login('bearer');
    assertEquals(await t.f.state.getTyped('playback.queueLimit'), 8192);
    await t.f.state.set('playback.queueLimit', '3');
    const path = '/api/v1/players/1/queue/items';
    const ref = { kind: 'song', id: t.songs[0].id };
    const add = (body: unknown) =>
      t.command(path, 'POST', credential, body, 200);
    await add({ references: [ref, ref] });
    const home = t.players.get(1);
    const before = home.queueView();
    const last = home.lastCommand();
    const response = await t.f.json(
      path,
      'POST',
      { references: [ref, ref] },
      credential,
    );
    assertEquals(response.status, 409);
    const refusal = await response.json();
    assertEquals([refusal.code, refusal.limit], ['queue_limit', 3]);
    assertEquals(home.queueView(), before);
    assertEquals(home.lastCommand(), last);
    await assertRejects(
      async () => {
        await home.queueAdd(t.songs);
      },
      Error,
      'Queue limit',
    );
    await assertRejects(
      async () => {
        await home.queueAddSources(before.items);
      },
      Error,
      'Queue limit',
    );
    const tooMany = await t.f.json(path, 'POST', {
      references: [ref, ref, ref, ref],
      clear: true,
      startPlaying: true,
    }, credential);
    assertEquals((await tooMany.json()).code, 'queue_limit');
    assertEquals(home.queueView(), before);
    const exact = await add({ references: [ref, ref, ref], clear: true });
    assertEquals(exact.count, 3);
    assertEquals(
      (await t.read('/api/v1/players/1/queue?view=all', credential)).total,
      3,
    );
    const kitchen = await t.players.create('Kitchen');
    assertEquals(
      (await t.command(
        `/api/v1/players/${kitchen.id}/queue/items`,
        'POST',
        credential,
        { references: [ref, ref, ref] },
        200,
      )).count,
      3,
    );
    await t.f.state.set('playback.queueLimit', '4');
    assertEquals((await add({ references: [ref] })).count, 1);
    await t.persistence.drain();
    assertEquals((await t.f.store.playback.loadQueue(1)).items.length, 4);
  } finally {
    await t.close();
  }
});

Deno.test('queue limit defaults to exactly 8192 even without a settings adapter', async () => {
  const t = await setup();
  const playback = createPlayback({
    player: createPlayer(),
    library: createLibrary(t.f.store),
    nowPlaying: createNowPlaying(t.f.store),
    cfg: {},
  });
  try {
    await playback.queueAdd(Array.from({ length: 8192 }, () => t.songs[0]));
    assertEquals(playback.queueView().items.length, 8192);
    await assertRejects(
      async () => {
        await playback.queueAdd(t.songs.slice(0, 1));
      },
      Error,
      '8192',
    );
    assertEquals(playback.queueView().items.length, 8192);
  } finally {
    await playback.close();
    await t.close();
  }
});

Deno.test('queue add HTTP start refusals preserve both queues and provenance', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const home = t.players.get(1);
    await home.queueAdd(t.songs);
    const body = {
      references: [{ kind: 'song', id: t.songs[1].id }],
      clear: true,
      startPlaying: true,
    };
    const before = home.queueView();
    await error(
      await t.f.json('/api/v1/players/1/queue/items', 'POST', body, credential),
      409,
      'no_target',
    );
    assertEquals(home.queueView(), before);
    await t.addSpeaker('add-home-airplay', 'AirPlay');
    await t.players.join(1, 'add-home-airplay');
    await home.play();
    const kitchen = await t.players.create('Kitchen');
    await t.addSpeaker('add-kitchen-airplay', 'AirPlay');
    await t.players.join(kitchen.id, 'add-kitchen-airplay');
    const other = t.players.get(kitchen.id);
    await other.queueAdd(t.songs);
    const otherBefore = other.queueView();
    const last = other.lastCommand();
    const response = await t.f.json(
      `/api/v1/players/${kitchen.id}/queue/items`,
      'POST',
      body,
      credential,
    );
    assertEquals(response.status, 409);
    const refusal = await response.json();
    assertEquals(refusal.code, 'airplay_busy');
    assertEquals(refusal.owner, { id: 1, name: 'Home' });
    assertEquals(other.queueView(), otherBefore);
    assertEquals(other.lastCommand(), last);
    assertEquals(home.queueView(), before);
    assertEquals(home.playerView().state, 'play');
  } finally {
    await t.close();
  }
});

Deno.test('queue add HTTP validates complete input and keeps auth, Origin and rebased routes', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const path = '/api/v1/players/1/queue/items';
    const ref = { kind: 'song', id: t.songs[0].id };
    const invalid = [
      {},
      { references: [] },
      { references: [null] },
      { references: 'song' },
      { references: [{ ...ref, extra: true }] },
      { references: [{ kind: 'query', id: 'x' }] },
      { references: [{ kind: 'song', id: 1 }] },
      { references: [{ kind: 'song', id: '' }] },
      { references: [ref], where: null },
      { references: [ref], where: 'bad' },
      ...[-1, 1.5, 9007199254740992, '1'].map((position) => ({
        references: [ref],
        where: { position },
      })),
      { references: [ref], where: { position: 1, extra: 2 } },
      { references: [ref], clear: 'true' },
      { references: [ref], startPlaying: 1 },
      { references: [ref], user: 'admin' },
    ];
    for (const body of invalid) {
      const response = await t.f.json(path, 'POST', body, credential);
      assertEquals(response.status, 400, await response.clone().text());
      await response.body?.cancel();
      assertEquals(t.players.get(1).queueView().items.length, 0);
    }
    for (
      const url of [
        'file:///etc/passwd',
        'ftp://melofon.home/a',
        'not a url',
        'http://user:pass@melofon.home/a',
      ]
    ) {
      await error(
        await t.f.json(path, 'POST', {
          references: [{ kind: 'url', url }],
          clear: true,
        }, credential),
        400,
        'invalid_reference',
      );
    }
    await error(
      await t.f.json(path, 'POST', { references: [ref] }),
      401,
      'unauthenticated',
    );
    await error(
      await t.f.json(path, 'POST', { references: [ref] }, credential, null),
      403,
      'origin',
    );
    const foreign = await t.f.json(
      path,
      'POST',
      { references: [ref] },
      credential,
      'http://other.home',
    );
    assertEquals(foreign.status, 403);
    await foreign.body?.cancel();
    await error(
      await t.f.json('/api/v1/players/999/queue/items', 'POST', {
        references: [ref],
      }, credential),
      404,
      'not_found',
    );
    assertEquals(
      (await t.command(`/_melofon${path}`, 'POST', credential, {
        references: [ref],
      }, 200)).count,
      1,
    );
  } finally {
    await t.close();
  }
});

Deno.test('queue HTTP pages whole and upcoming snapshots across edits with independent player versions', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const path = '/api/v1/players/1';
    const kitchen = await t.players.create('Kitchen');
    const other = t.players.get(kitchen.id);
    await other.queueAdd([t.songs[1]]);
    const otherBefore = await t.read(
      `/api/v1/players/${kitchen.id}/queue`,
      credential,
    );
    const home = t.players.get(1);
    const entries = await home.queueAdd([
      t.songs[0],
      t.songs[1],
      t.songs[0],
      t.songs[1],
    ]);
    const ids = entries.map((entry) => entry.id);
    assertEquals(new Set(ids).size, 4);
    assert(!ids.includes(otherBefore.items[0].entryId));
    const page1 = await t.read(`${path}/queue?view=all&limit=2`, credential);
    assertEquals([
      page1.view,
      page1.startIndex,
      page1.total,
      page1.offset,
      page1.limit,
      page1.currentEntryId,
    ], ['all', 0, 4, 0, 2, null]);
    assertEquals(
      page1.items.map((item: { entryId: number }) => item.entryId),
      ids.slice(0, 2),
    );
    assertEquals(
      page1.items.map((item: { position: number }) => item.position),
      [0, 1],
    );
    assertEquals(page1.items[0].reference, { kind: 'song', id: t.songs[0].id });
    assertEquals(page1.items[0].song.id, t.songs[0].id);
    const page2 = await t.read(
      `${path}/queue?view=all&offset=2&limit=2`,
      credential,
    );
    assertEquals(page2.version, page1.version);
    assertEquals(
      page2.items.map((item: { entryId: number }) => item.entryId),
      ids.slice(2),
    );
    assertEquals(
      (await t.read(path, credential)).player.queueVersion,
      page1.version,
    );
    const added = await home.queueAdd([t.songs[0]], { position: 1 });
    const edited = await t.read(
      `${path}/queue?view=all&offset=2&limit=2`,
      credential,
    );
    assert(edited.version > page1.version);
    assertEquals(edited.total, 5);
    assertEquals(
      edited.items.map((item: { entryId: number }) => item.entryId),
      ids.slice(1, 3),
    );
    assertEquals(
      (await t.read(path, credential)).player.queueVersion,
      edited.version,
    );
    assertEquals(
      await t.read(`/api/v1/players/${kitchen.id}/queue`, credential),
      otherBefore,
    );
    const all = await t.read(`${path}/queue?view=all`, credential);
    assertEquals(all.items.map((item: { entryId: number }) => item.entryId), [
      ids[0],
      added[0].id,
      ...ids.slice(1),
    ]);
    for (const offset of [5, 999, 9007199254740991]) {
      const beyond = await t.read(`${path}/queue?offset=${offset}`, credential);
      assertEquals([beyond.total, beyond.items, beyond.version], [
        5,
        [],
        edited.version,
      ]);
    }
    await t.persistence.drain();
    assertEquals(
      (await t.f.store.playback.loadQueue(1)).version,
      edited.version,
    );
  } finally {
    await t.close();
  }
});

Deno.test('queue HTTP up next includes current across navigation pause stop exhaustion and clear', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const path = '/_melofon/api/v1/players/1';
    const empty = await t.read(`${path}/queue`, credential);
    assertEquals([
      empty.view,
      empty.total,
      empty.startIndex,
      empty.currentEntryId,
      empty.items,
    ], ['upNext', 0, 0, null, []]);
    const home = t.players.get(1);
    const entries = await home.queueAdd([t.songs[0], t.songs[1], t.songs[0]]);
    await t.addSpeaker('queue');
    await t.players.join(1, 'queue');
    await t.command(`${path}/play`, 'POST', credential, {});
    const first = await t.read(`${path}/queue?limit=1`, credential);
    assertEquals(first.items[0].entryId, entries[0].id);
    await t.command(`${path}/next`, 'POST', credential, {});
    const next = await t.read(`${path}/queue?limit=1`, credential);
    assertEquals([
      next.version,
      next.currentEntryId,
      next.startIndex,
      next.total,
    ], [first.version, entries[1].id, 1, 2]);
    assertEquals(next.items[0].entryId, entries[1].id);
    const page2 = await t.read(`${path}/queue?offset=1&limit=1`, credential);
    assertEquals([page2.items[0].entryId, page2.items[0].position], [
      entries[2].id,
      2,
    ]);
    const all = await t.read(`${path}/queue?view=all`, credential);
    assertEquals([all.total, all.startIndex, all.currentEntryId], [
      3,
      0,
      entries[1].id,
    ]);
    for (const command of ['pause', 'stop', 'restart']) {
      await t.command(`${path}/${command}`, 'POST', credential, {});
      assertEquals(await t.read(`${path}/queue?limit=1`, credential), next);
    }
    await t.command(
      path,
      'PATCH',
      credential,
      { repeat: 'all', consume: true },
      200,
    );
    assertEquals(
      (await t.read(`${path}/queue`, credential)).version,
      first.version,
    );
    await t.command(`${path}/next`, 'POST', credential, {});
    await t.command(`${path}/next`, 'POST', credential, {});
    const exhausted = await t.read(`${path}/queue`, credential);
    assertEquals([
      exhausted.total,
      exhausted.startIndex,
      exhausted.currentEntryId,
    ], [3, 0, null]);
    assertEquals(exhausted.version, first.version);
    home.queueClear();
    const cleared = await t.read(`${path}/queue`, credential);
    assertEquals([cleared.total, cleared.items, cleared.currentEntryId], [
      0,
      [],
      null,
    ]);
    assert(cleared.version > exhausted.version);
    assertEquals(
      (await t.read(path, credential)).player.queueVersion,
      cleared.version,
    );
  } finally {
    await t.close();
  }
});

Deno.test('queue HTTP encodes original web references and refreshed facts without private source details', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const path = '/api/v1/players/1';
    const home = t.players.get(1);
    const facts = {
      kind: 'web' as const,
      url: 'http://private-source.home/resolved',
      title: 'Radio',
      artistName: null,
      durationMs: null,
      mode: 'live' as const,
      seekable: false,
      streamTitle: 'On air',
      streamUrl: 'http://private-source.home/metadata',
    };
    const station = await t.f.store.radio.create({
      name: 'Radio',
      streamUrl: facts.url,
      homePageUrl: null,
    });
    const entries = await home.queueAddSources([
      { reference: { kind: 'station', id: station.id }, facts },
      { reference: { kind: 'url', url: 'http://entered.home/radio' }, facts },
    ]);
    await t.addSpeaker('radio');
    await t.players.join(1, 'radio');
    const before = await t.read(`${path}/queue`, credential);
    assertEquals(
      before.items.map((item: { reference: unknown }) => item.reference),
      [
        { kind: 'station', id: station.id },
        { kind: 'url', url: 'http://entered.home/radio' },
      ],
    );
    assertEquals(before.items[0].media, {
      kind: 'web',
      title: 'Radio',
      artistName: null,
      durationMs: null,
      mode: 'live',
      seekable: false,
      streamTitle: 'On air',
    });
    assert(!JSON.stringify(before).includes('private-source'));
    assert(!JSON.stringify(before).includes('path'));
    await t.command(`${path}/play`, 'POST', credential, {});
    const activated = await t.read(`${path}/queue`, credential);
    const status = home.playerView();
    const token = home.openSource(entries[0].id, status.generation)!;
    assert(token);
    assert(home.reportSourceMetadata(token, { streamTitle: 'New title' }));
    const after = await t.read(`${path}/queue`, credential);
    assert(after.version > activated.version);
    assertEquals(after.items[0].entryId, entries[0].id);
    assertEquals(after.items[0].media.streamTitle, 'New title');
    assertEquals(
      (await t.read(path, credential)).player.queueVersion,
      after.version,
    );
    home.cancelSource(token);
  } finally {
    await t.close();
  }
});

Deno.test('queue HTTP validates paging and settings and requires auth but not Origin on reads', async () => {
  const t = await setup();
  try {
    await t.players.get(1).queueAdd([t.songs[0], t.songs[1], t.songs[0]]);
    await t.f.state.set('melofon.queueMaxPageRecords', '2');
    await t.f.state.set('melofon.queuePageRecords', '3');
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      const path = `${
        mode === 'cookie' ? '' : '/_melofon'
      }/api/v1/players/1/queue`;
      const page = await t.read(path, credential);
      assertEquals([page.limit, page.items.length, page.total], [2, 2, 3]);
      const read = await t.f.get(path, credential);
      assertEquals(read.status, 200);
      await read.body?.cancel();
      for (
        const query of [
          'view=bad',
          'view=',
          'view=all&view=upNext',
          'offset=-1',
          'offset=1.5',
          'offset=1e1',
          'offset=',
          'offset=9007199254740992',
          'offset=0&offset=1',
          'limit=0',
          'limit=-1',
          'limit=1.5',
          'limit=3',
          'limit=',
          'limit=1&limit=2',
          'unknown=1',
        ]
      ) {
        await error(
          await t.f.get(`${path}?${query}`, credential),
          400,
          'invalid_field',
        );
      }
      for (const id of ['0', '01', '-1', '1.5', '9007199254740992', '99999']) {
        await error(
          await t.f.get(`/api/v1/players/${id}/queue`, credential),
          404,
          'not_found',
        );
      }
    }
    await error(
      await t.f.get('/api/v1/players/1/queue'),
      401,
      'unauthenticated',
    );
  } finally {
    await t.close();
  }
});

Deno.test('players HTTP lifecycle is shared by cookie and Bearer users on non-loopback plain HTTP', async () => {
  const t = await setup();
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      const base = mode === 'cookie'
        ? '/api/v1/players'
        : '/_melofon/api/v1/players';
      assertEquals(await t.read(base, credential), {
        players: [{ id: 1, name: 'Home', isDefault: true }],
      });
      const created = await t.command(base, 'POST', credential, {
        name: ' Kitchen ',
      }, 201);
      const id = created.player.id;
      assertEquals(created, {
        player: { id, name: 'Kitchen', isDefault: false },
      });
      const initial = (await t.read(`${base}/${id}`, credential)).player;
      assertEquals(initial.state, 'stop');
      assertEquals(initial.current, null);
      assertEquals(initial.speakers, []);
      const renamed = await t.command(`${base}/${id}`, 'PATCH', credential, {
        name: 'Study',
      }, 200);
      assertEquals(renamed.player.name, 'Study');
      await error(
        await t.f.json(`${base}/${id}`, 'PATCH', { name: 'HOME' }, credential),
        409,
        'name_conflict',
      );
      await t.command(`${base}/${id}/default`, 'POST', credential, {});
      assertEquals(
        (await t.read(`${base}/${id}`, credential)).player.isDefault,
        true,
      );
      assertEquals(
        (await t.f.store.players.list()).find((r) => r.id === id)?.isDefault,
        true,
      );
      await error(
        await t.f.json(`${base}/${id}`, 'DELETE', undefined, credential),
        409,
        'default_player',
      );
      await t.command(`${base}/1/default`, 'POST', credential, {});
      await t.command(`${base}/${id}`, 'DELETE', credential);
      await error(await t.f.get(`${base}/${id}`, credential), 404, 'not_found');
      assertEquals((await t.f.store.players.list()).length, 1);
    }
  } finally {
    await t.close();
  }
});

Deno.test('players HTTP rejects unauthenticated, cross-origin, malformed and conflicting changes without mutation', async () => {
  const t = await setup();
  try {
    const base = '/api/v1/players';
    await error(await t.f.get(base), 401, 'unauthenticated');
    await error(await t.f.get(`${base}/1`), 401, 'unauthenticated');
    await error(
      await t.f.json(base, 'POST', { name: 'Denied' }),
      401,
      'unauthenticated',
    );
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      await error(
        await t.f.json(
          base,
          'POST',
          { name: 'Denied' },
          credential,
          'http://other.home',
        ),
        403,
        'origin',
      );
      await error(
        await t.f.json(base, 'POST', { name: 'home' }, credential),
        409,
        'name_conflict',
      );
      await error(
        await t.f.json(base, 'POST', { name: ' ' }, credential),
        400,
        'invalid_name',
      );
      await error(
        await t.f.json(base, 'POST', { name: 3 }, credential),
        400,
        'invalid_field',
      );
      await error(
        await t.f.json(base, 'POST', { name: 'OK', extra: true }, credential),
        400,
        'unknown_field',
      );
      await error(
        await t.f.json(`${base}/1`, 'PATCH', {}, credential),
        400,
        'invalid_field',
      );
      await error(
        await t.f.json(`${base}/1`, 'DELETE', undefined, credential),
        409,
        'last_player',
      );
      for (const id of ['0', '-1', '01', '1e0', '9007199254740992', '999']) {
        await error(
          await t.f.get(`${base}/${id}`, credential),
          404,
          'not_found',
        );
      }
      await error(
        await t.f.json(`${base}/999/default`, 'POST', {}, credential),
        404,
        'not_found',
      );
    }
    assertEquals(t.players.list().map((r) => r.name), ['Home']);
  } finally {
    await t.close();
  }
});

Deno.test('players HTTP moves and releases adopted and temporary speakers, retaining the old player bookmark', async () => {
  const t = await setup();
  try {
    const a = await t.f.login('cookie');
    const b = await t.f.login('bearer', 'member', 'password-member');
    const kitchen = await t.players.create('Kitchen');
    await t.addSpeaker('one');
    await t.addSpeaker('temporary', 'Test', false);
    const path = (id: number, speaker: string) =>
      `/api/v1/players/${id}/speakers/${speaker}`;
    await t.command(path(1, 'one'), 'PUT', a.credential, {});
    await t.players.get(1).queueAdd(t.songs, { play: true }, {
      kind: 'http',
      user: 'admin',
    });
    await t.players.get(1).seek({ positionMs: 100 });
    const queue = t.players.get(1).queueView();
    await t.command(path(kitchen.id, 'one'), 'PUT', b.credential, {});
    await t.command(path(kitchen.id, 'one'), 'PUT', b.credential, {});
    const home = (await t.read('/api/v1/players/1', a.credential)).player;
    assertEquals(home.state, 'pause');
    assertEquals(home.positionMs, 100);
    assertEquals(home.current.entryId, queue.items[0].id);
    assertEquals(home.current.commander, 'admin');
    assertEquals(t.players.get(1).queueView(), queue);
    let speaker = (await t.read('/api/v1/speakers/one', a.credential)).speaker;
    assertEquals(speaker.playerId, kitchen.id);
    assertEquals(speaker.linked, true);
    assertEquals(
      (await t.f.store.speakers.loadMemberships())[0].playerId,
      kitchen.id,
    );
    await t.command(path(1, 'one'), 'DELETE', a.credential);
    assertEquals(
      t.outputs.get('one')!.playerId,
      kitchen.id,
      'scoped leave never steals another member',
    );
    await t.command(path(kitchen.id, 'one'), 'DELETE', b.credential);
    await t.command(path(kitchen.id, 'one'), 'DELETE', b.credential);
    speaker = (await t.read('/api/v1/speakers/one', b.credential)).speaker;
    assertEquals(speaker.playerId, null);
    await t.command(path(kitchen.id, 'temporary'), 'PUT', b.credential, {});
    assertEquals(
      (await t.f.store.speakers.loadOutputs()).length,
      1,
      'temporary membership is not saved',
    );
    await t.command(`/api/v1/players/${kitchen.id}`, 'DELETE', b.credential);
    assertEquals(t.players.freeSpeakers().map((r) => r.id).sort(), [
      'one',
      'temporary',
    ]);
    await error(
      await t.f.json(path(1, 'missing'), 'PUT', {}, a.credential),
      404,
      'not_found',
    );
    await error(
      await t.f.json(path(999, 'one'), 'DELETE', undefined, a.credential),
      404,
      'not_found',
    );
  } finally {
    await t.close();
  }
});

Deno.test('players HTTP translates AirPlay membership refusal with the live owner id and name', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const kitchen = await t.players.create('Kitchen');
    await t.addSpeaker('air', 'AirPlay');
    await t.addSpeaker('free-air', 'AirPlay');
    await t.addSpeaker('other');
    await t.players.join(1, 'air');
    await t.players.join(kitchen.id, 'other');
    await t.players.get(1).queueAdd(t.songs, { play: true });
    await t.players.get(kitchen.id).queueAdd(t.songs, { play: true });
    await t.command('/api/v1/players/1', 'PATCH', credential, {
      name: 'Living room',
    }, 200);
    const response = await t.f.json(
      `/api/v1/players/${kitchen.id}/speakers/free-air`,
      'PUT',
      {},
      credential,
    );
    assertEquals(response.status, 409);
    const body = await response.json();
    assertEquals(body.code, 'airplay_busy');
    assertEquals(body.owner, { id: 1, name: 'Living room' });
    assertEquals(outputPlayerId(t.outputs.get('free-air')!), null);
    assertEquals(t.players.get(1).playerView().state, 'play');
    assertEquals(t.players.get(kitchen.id).playerView().state, 'play');
  } finally {
    await t.close();
  }
});

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'players event timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test('a second user socket sees lifecycle, keyed player queue modes volume and speaker invalidations', async () => {
  const t = await setup();
  let ws: WebSocket | undefined;
  try {
    const actor = await t.f.login('cookie');
    const observer = await t.f.login('bearer', 'member', 'password-member');
    const frames: { type: string; events?: Record<string, string[]> }[] = [];
    ws = new WebSocket(t.f.origin.replace('http:', 'ws:') + '/api/v1/events', {
      headers: {
        Authorization: `Bearer ${observer.credential}`,
        Origin: t.f.origin,
      },
    });
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await waitFor(() => frames.some((f) => f.type === 'hello'));
    const changed = async (name: string, id?: string) => {
      await waitFor(() =>
        frames.some((f) =>
          f.events?.[name] && (id === undefined || f.events[name].includes(id))
        )
      );
      frames.length = 0;
    };
    const { player } = await t.command(
      '/api/v1/players',
      'POST',
      actor.credential,
      { name: 'Kitchen' },
      201,
    );
    await changed('players', String(player.id));
    await t.addSpeaker('speaker');
    await t.command(
      `/api/v1/players/${player.id}/speakers/speaker`,
      'PUT',
      actor.credential,
      {},
    );
    await changed('speakers');
    const playback = t.players.get(player.id);
    await playback.queueAdd(t.songs, { play: true });
    await waitFor(() =>
      ['player', 'queue'].every((name) =>
        frames.some((f) => f.events?.[name]?.includes(String(player.id)))
      )
    );
    frames.length = 0;
    playback.setRepeat('all');
    await changed('options', String(player.id));
    playback.setVolume({ volume: 30 });
    await changed('volume', String(player.id));
    await t.command(`/api/v1/players/${player.id}`, 'PATCH', actor.credential, {
      name: 'Study',
    }, 200);
    await waitFor(() => frames.some((f) => f.events?.nowPlaying));
    await changed('players', String(player.id));
    assertEquals(
      (await t.read(`/api/v1/players/${player.id}`, observer.credential)).player
        .name,
      'Study',
    );
    const editPath = `/api/v1/players/${player.id}/queue`;
    const first = playback.queueView().items[0].id;
    await t.command(`${editPath}/items/${first}`, 'PATCH', actor.credential, {
      position: 1,
    });
    await changed('queue', String(player.id));
    assertEquals(
      (await t.read(`${editPath}?view=all`, observer.credential)).items[1]
        .entryId,
      first,
    );
    await t.command(`${editPath}/items/${first}`, 'DELETE', actor.credential);
    await waitFor(() =>
      ['queue', 'player'].every((name) =>
        frames.some((f) => f.events?.[name]?.includes(String(player.id)))
      )
    );
    frames.length = 0;
    await t.command(editPath, 'DELETE', actor.credential);
    await waitFor(() =>
      ['queue', 'player'].every((name) =>
        frames.some((f) => f.events?.[name]?.includes(String(player.id)))
      )
    );
    frames.length = 0;
    assertEquals((await t.read(editPath, observer.credential)).total, 0);
    for (const mode of ['replace', 'add']) {
      await t.command(`${editPath}/copy/${mode}`, 'POST', actor.credential, {
        targetPlayerId: 1,
      });
      await waitFor(() =>
        frames.some((f) => f.events?.player?.includes(String(player.id))) &&
        frames.some((f) => f.events?.queue?.includes('1')) &&
        (mode === 'add' || frames.some((f) => f.events?.player?.includes('1')))
      );
      frames.length = 0;
      assertEquals(
        (await t.read('/api/v1/players/1/queue', observer.credential)).total,
        0,
      );
    }
    await t.command(
      `/api/v1/players/${player.id}/default`,
      'POST',
      actor.credential,
      {},
    );
    await waitFor(() =>
      ['players', 'player', 'queue', 'volume', 'options'].every((name) =>
        frames.some((f) => f.events?.[name]?.includes(String(player.id)))
      )
    );
    frames.length = 0;
    await t.command('/api/v1/players/1/default', 'POST', actor.credential, {});
    await changed('players', '1');
    await t.command(`/api/v1/players/${player.id}`, 'DELETE', actor.credential);
    await changed('players', String(player.id));
    await error(
      await t.f.get(`/api/v1/players/${player.id}`, observer.credential),
      404,
      'not_found',
    );
  } finally {
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    if (ws) await waitFor(() => ws!.readyState === WebSocket.CLOSED);
    await t.close();
  }
});

Deno.test('household HTTP identifies each server player while OpenSubsonic retains its shape and disjoint integer ids', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'cookie',
      'member',
      'password-member',
    );
    const kitchen = await t.players.create('Kitchen');
    for (const id of [1, kitchen.id]) {
      await t.addSpeaker(`speaker-${id}`);
      await t.players.join(id, `speaker-${id}`);
      await t.players.get(id).queueAdd([t.songs[id === 1 ? 0 : 1]], {
        play: true,
      }, { kind: 'http', user: 'member', peer: 'private-peer' });
    }
    await t.players.playback.reportPlayback({
      username: 'member',
      client: 'Phone',
      trackId: t.songs[0].id,
      state: 'playing',
      positionMs: 0,
      playbackRate: 1,
      source: 'melofon',
      ignoreScrobble: true,
    });
    const before = await t.read('/api/v1/now-playing', credential);
    const rows = before.nowPlaying;
    assertEquals(
      rows.filter((r: { kind: string }) => r.kind === 'server').map((
        r: { playerId: number; playerName: string },
      ) => [r.playerId, r.playerName]),
      [[1, 'Home'], [kitchen.id, 'Kitchen']],
    );
    const app = rows.find((r: { kind: string }) => r.kind === 'app');
    assert(app.appPlayerId > 0);
    for (
      const privateValue of [
        t.dir,
        'private-peer',
        ...t.songs.map((s) => s.path),
      ]
    ) assert(!JSON.stringify(before).includes(privateValue));
    await t.command(`/api/v1/players/${kitchen.id}`, 'PATCH', credential, {
      name: 'Study',
    }, 200);
    assertEquals(
      (await t.read('/api/v1/now-playing', credential)).nowPlaying[1]
        .playerName,
      'Study',
    );
    const response = await t.f.get(
      '/rest/getNowPlaying?' +
        new URLSearchParams({
          u: 'admin',
          p: 'password-admin',
          c: 'Test',
          v: '1.16.1',
          f: 'json',
        }),
    );
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok');
    const entries = body.nowPlaying.entry;
    assertEquals(entries.map((r: { playerId: number }) => r.playerId), [
      0,
      1 - kitchen.id,
      app.appPlayerId,
    ]);
    assertEquals(entries.map((r: { playerName: string }) => r.playerName), [
      'Home',
      'Study',
      'Phone',
    ]);
    for (const entry of entries) {
      assertEquals(typeof entry.id, 'string');
      assertEquals(typeof entry.username, 'string');
      assertEquals(typeof entry.minutesAgo, 'number');
      assert(!('serverPlayerId' in entry));
      assert(!('speakers' in entry));
      assert(!('commander' in entry));
      assert(!('kind' in entry));
    }
  } finally {
    await t.close();
  }
});

Deno.test('player commands HTTP preserve per-player bookmarks, previous/restart semantics and authenticated provenance', async () => {
  const t = await setup();
  try {
    const kitchen = await t.players.create('Kitchen');
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      const base = mode === 'cookie' ? '/api/v1' : '/_melofon/api/v1';
      const id = mode === 'cookie' ? 1 : kitchen.id;
      const path = `${base}/players/${id}`;
      await t.addSpeaker(`speaker-${id}`);
      await t.players.join(id, `speaker-${id}`);
      const entries = await t.players.get(id).queueAdd(t.songs);
      const other = t.players.get(id === 1 ? kitchen.id : 1);
      const otherBefore = other.playerView();
      const otherCommand = other.lastCommand();
      const state = async () => (await t.read(path, credential)).player;
      const command = (name: string, body: unknown = {}) =>
        t.command(`${path}/${name}`, 'POST', credential, body);
      await command('play');
      assertEquals((await state()).state, 'play');
      assertEquals((await state()).current.entryId, entries[0].id);
      await command('seek', { positionMs: 100 });
      assertEquals((await state()).positionMs, 100);
      await command('seek', { seekMs: 25 });
      assertEquals((await state()).positionMs, 125);
      await command('seek', { seekMs: -50 });
      assertEquals((await state()).positionMs, 75);
      await command('pause');
      assertEquals([(await state()).state, (await state()).positionMs], [
        'pause',
        75,
      ]);
      await command('restart');
      assertEquals([(await state()).state, (await state()).positionMs], [
        'pause',
        0,
      ]);
      await command('play');
      await t.command(path, 'PATCH', credential, { repeat: 'single' }, 200);
      await command('next');
      assertEquals((await state()).current.entryId, entries[1].id);
      await command('seek', { positionMs: 150 });
      await command('restart');
      assertEquals((await state()).current.entryId, entries[1].id);
      assertEquals([(await state()).state, (await state()).positionMs], [
        'play',
        0,
      ]);
      await command('previous');
      assertEquals((await state()).current.entryId, entries[0].id);
      await command('seek', { positionMs: 100 });
      await command('previous');
      assertEquals((await state()).current.entryId, entries[0].id);
      assertEquals((await state()).positionMs, 0);
      await command('seek', { positionMs: 100 });
      await command('stop');
      assertEquals([(await state()).state, (await state()).positionMs], [
        'pause',
        100,
      ]);
      assertEquals((await state()).current.entryId, entries[0].id);
      assertEquals((await state()).speakers[0].id, `speaker-${id}`);
      await command('play');
      assertEquals([(await state()).state, (await state()).positionMs], [
        'play',
        100,
      ]);
      assertEquals((await state()).current.commander, 'member');
      const provenance = t.players.get(id).lastCommand()!.source;
      assertEquals(provenance.kind, 'http');
      assertEquals(provenance.via, 'melofon');
      assertEquals(provenance.user, 'member');
      assertEquals(provenance.userAgent, 'Melofon API test');
      assert(provenance.peer);
      assertEquals(other.playerView(), otherBefore);
      assertEquals(other.lastCommand(), otherCommand);
    }
  } finally {
    await t.close();
  }
});

Deno.test('player command HTTP validates bodies, methods, authentication and Origin before mutation', async () => {
  const t = await setup();
  try {
    const base = '/api/v1/players/1';
    for (const mode of ['cookie', 'bearer'] as const) {
      const { credential } = await t.f.login(mode, 'member', 'password-member');
      const before = t.players.get(1).lastCommand();
      for (
        const action of [
          'play',
          'pause',
          'stop',
          'next',
          'previous',
          'restart',
          'seek',
        ]
      ) {
        const body = action === 'seek' ? { positionMs: 0 } : {};
        await error(
          await t.f.json(`${base}/${action}`, 'POST', body),
          401,
          'unauthenticated',
        );
        await error(
          await t.f.json(
            `${base}/${action}`,
            'POST',
            body,
            credential,
            'http://other.home',
          ),
          403,
          'origin',
        );
        await error(
          await t.f.json(
            `${base}/${action}`,
            'POST',
            { ...body, extra: true },
            credential,
          ),
          400,
          'unknown_field',
        );
        await error(
          await t.f.json(
            `/api/v1/players/999/${action}`,
            'POST',
            body,
            credential,
          ),
          404,
          'not_found',
        );
        await error(
          await t.f.json(
            `/api/v1/players/01/${action}`,
            'POST',
            body,
            credential,
          ),
          404,
          'not_found',
        );
        const read = await t.f.get(`${base}/${action}`, credential);
        assertEquals(read.status, 405);
        await read.body?.cancel();
      }
      for (
        const body of [
          {},
          { positionMs: 1, seekMs: 2 },
          { positionMs: -1 },
          { positionMs: 0.5 },
          { positionMs: '2' },
          { seekMs: null },
          { seekMs: 0.5 },
          { seekMs: 9007199254740992 },
        ]
      ) {
        await error(
          await t.f.json(`${base}/seek`, 'POST', body, credential),
          400,
          'invalid_field',
        );
      }
      const noOrigin = await t.f.json(
        `${base}/pause`,
        'POST',
        {},
        credential,
        null,
      );
      if (mode === 'cookie') await error(noOrigin, 403, 'origin');
      else {
        assertEquals(noOrigin.status, 204);
        await noOrigin.body?.cancel();
      }
      if (mode === 'cookie') {
        assertEquals(t.players.get(1).lastCommand(), before);
      }
    }
  } finally {
    await t.close();
  }
});

Deno.test('player modes HTTP validates the whole PATCH, persists modes per player and notifies another user', async () => {
  const t = await setup();
  let ws: WebSocket | undefined;
  try {
    const actor = await t.f.login('cookie', 'member', 'password-member');
    const observer = await t.f.login('bearer');
    const kitchen = await t.players.create('Kitchen');
    const frames: { type: string; events?: Record<string, string[]> }[] = [];
    ws = new WebSocket(t.f.origin.replace('http:', 'ws:') + '/api/v1/events', {
      headers: {
        Authorization: `Bearer ${observer.credential}`,
        Origin: t.f.origin,
      },
    });
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await waitFor(() => frames.some((f) => f.type === 'hello'));
    const path = `/api/v1/players/${kitchen.id}`;
    for (
      const body of [
        { repeat: true },
        { repeat: 'one' },
        { repeat: null },
        { consume: 1 },
        { consume: null },
        { name: 'Changed', repeat: 'all', consume: 'yes' },
        { repeat: 'all', shuffle: true },
      ]
    ) {
      await error(
        await t.f.json(path, 'PATCH', body, actor.credential),
        400,
        'shuffle' in body ? 'unknown_field' : 'invalid_field',
      );
    }
    await error(
      await t.f.json(
        path,
        'PATCH',
        { name: 'Home', consume: true },
        actor.credential,
      ),
      409,
      'name_conflict',
    );
    assertEquals(t.players.list()[1].name, 'Kitchen');
    assertEquals(t.players.get(kitchen.id).playerView().repeat, 'off');
    assertEquals(t.players.get(kitchen.id).playerView().consume, false);
    await error(
      await t.f.json(path, 'PATCH', { repeat: 'all' }),
      401,
      'unauthenticated',
    );
    await error(
      await t.f.json(
        path,
        'PATCH',
        { repeat: 'all' },
        actor.credential,
        'http://other.home',
      ),
      403,
      'origin',
    );
    for (const repeat of ['all', 'single', 'off']) {
      const { player } = await t.command(path, 'PATCH', actor.credential, {
        repeat,
      }, 200);
      assertEquals(player.repeat, repeat);
    }
    const { player } = await t.command(path, 'PATCH', actor.credential, {
      name: 'Study',
      repeat: 'single',
      consume: true,
    }, 200);
    assertEquals([player.name, player.repeat, player.consume], [
      'Study',
      'single',
      true,
    ]);
    await waitFor(() =>
      frames.some((f) => f.events?.options?.includes(String(kitchen.id)))
    );
    const visible = (await t.read(path, observer.credential)).player;
    assertEquals([visible.repeat, visible.consume], ['single', true]);
    await t.persistence.drain();
    const saved = await t.f.store.playback.loadPlayerState(kitchen.id);
    assertEquals([saved?.repeat, saved?.consume], ['single', true]);
    assertEquals(t.players.get(1).playerView().repeat, 'off');
    assertEquals(t.players.get(1).playerView().consume, false);
    assertEquals(
      t.players.get(kitchen.id).lastCommand()?.source.user,
      'member',
    );
    await t.command(
      path,
      'PATCH',
      observer.credential,
      { consume: false },
      200,
    );
    assertEquals((await t.read(path, actor.credential)).player.consume, false);
  } finally {
    if (ws && ws.readyState < WebSocket.CLOSING) ws.close();
    if (ws) await waitFor(() => ws!.readyState === WebSocket.CLOSED);
    await t.close();
  }
});

Deno.test('player command HTTP returns no_target and airplay_busy without mutating either player', async () => {
  const t = await setup();
  try {
    const { credential } = await t.f.login(
      'bearer',
      'member',
      'password-member',
    );
    const kitchen = await t.players.create('Kitchen');
    const playback = t.players.get(kitchen.id);
    await playback.queueAdd(t.songs);
    for (
      const [action, body] of [['play', {}], ['next', {}], ['previous', {}], [
        'seek',
        { positionMs: 100 },
      ]] as const
    ) {
      await error(
        await t.f.json(
          `/api/v1/players/${kitchen.id}/${action}`,
          'POST',
          body,
          credential,
        ),
        409,
        'no_target',
      );
      assertEquals(playback.playerView().state, 'stop');
      assertEquals(playback.playerView().current, null);
    }
    for (const id of [1, kitchen.id]) {
      await t.addSpeaker(`air-${id}`, 'AirPlay');
      await t.players.join(id, `air-${id}`);
    }
    await t.players.get(1).queueAdd(t.songs);
    await t.command('/api/v1/players/1/play', 'POST', credential, {});
    await t.command('/api/v1/players/1', 'PATCH', credential, {
      name: 'Living room',
    }, 200);
    const before = playback.playerView();
    const queue = playback.queueView();
    const last = playback.lastCommand();
    for (
      const [action, body] of [['play', {}], ['next', {}], ['previous', {}], [
        'seek',
        { seekMs: 100 },
      ]] as const
    ) {
      const response = await t.f.json(
        `/api/v1/players/${kitchen.id}/${action}`,
        'POST',
        body,
        credential,
      );
      assertEquals(response.status, 409);
      assertEquals(await response.json(), {
        code: 'airplay_busy',
        message: 'AirPlay is busy in Living room',
        owner: { id: 1, name: 'Living room' },
      });
      assertEquals(playback.playerView(), before);
      assertEquals(playback.queueView(), queue);
      assertEquals(playback.lastCommand(), last);
      assertEquals(t.players.get(1).playerView().state, 'play');
    }
    await t.command('/api/v1/players/1/stop', 'POST', credential, {});
    await t.command(
      `/api/v1/players/${kitchen.id}/play`,
      'POST',
      credential,
      {},
    );
    assertEquals(
      (await t.read(`/api/v1/players/${kitchen.id}`, credential)).player.state,
      'play',
    );
  } finally {
    await t.close();
  }
});
