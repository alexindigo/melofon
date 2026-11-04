import { assert, assertEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { restored } from './helpers/prepared.ts';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createUserService } from '../src/user.ts';
import { createListens } from '../src/listens.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayback, type Playback } from '../src/playback.ts';
import { createPlayer, type PlayerPersistence } from '../src/player.ts';
import {
  catalogMedia,
  type QueueMedia,
  type QueueSnapshot,
  queueSong,
} from '../src/queue-source.ts';
import { wireInt } from '../layers/owntone/payloads.ts';
import { createPersistence, type Persistence } from '../src/persistence.ts';
import { createQueueResolver } from '../src/queue-source.ts';
import { planRestore } from '../src/player.ts';
import { assertRejects } from '@std/assert';

function web(kind: 'station' | 'url' = 'url'): QueueMedia {
  const url = 'http://melofon.home:1234/radio?token=private-query#station';
  return {
    reference: kind === 'station' ? { kind, id: 'station-1' } : { kind, url },
    facts: {
      kind: 'web',
      url: 'http://melofon.home:1234/resolved',
      title: 'Station name',
      artistName: null,
      durationMs: null,
      mode: 'live',
      seekable: false,
      streamTitle: 'Artist - On air',
      streamUrl: 'http://melofon.home:1234/image',
    },
  };
}

async function setup(persistence?: PlayerPersistence | true, dataDir?: string) {
  const dir = dataDir ?? await restored('queue-source', async (dir) => {
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
  }, 'melofon-queue-source-');
  let playback!: Playback;
  let durable: Persistence | undefined;
  const f = await apiFixture({
    storeDir: dir,
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: (f) => {
      const library = createLibrary(f.store);
      durable = persistence === true ? createPersistence(f.store) : undefined;
      playback = createPlayback({
        player: createPlayer(),
        library,
        nowPlaying: createNowPlaying(f.store),
        cfg: f.cfg,
        notify: f.notify,
        persistence: durable ??
          (persistence === true ? undefined : persistence),
        ...(durable
          ? {
            resolveQueueReference: createQueueResolver({
              getSong: library.getSong,
              getStation: f.store.radio.get,
            }),
          }
          : {}),
      });
      return Promise.resolve({
        library,
        playback,
        annotation: createAnnotation(f.store),
        user: createUserService(f.store, f.cfg),
        listens: createListens(f.store),
      });
    },
  });
  const songs = await createLibrary(f.store).listSongs({ size: 3, offset: 0 });
  const own = async (path: string, method = 'GET') => {
    return await fetch(`http://melofon.home:${f.extraPorts[0]}${path}`, {
      method,
      signal: AbortSignal.timeout(5000),
    });
  };
  const rest = async () => {
    const response = await f.get(
      '/rest/getNowPlaying?u=admin&p=password-admin&c=Phone&v=1.16.1&f=json',
    );
    assertEquals(response.status, 200);
    const body = (await response.json())['subsonic-response'];
    assertEquals(body.status, 'ok');
    return body.nowPlaying.entry ?? [];
  };
  return {
    f,
    playback,
    songs,
    own,
    rest,
    durable,
    dir,
    async close(keep = false) {
      await playback.close();
      await durable?.drain();
      await f.close();
      if (!keep) await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('typed queue: mixed catalog/station/URL rows project safely through real hat listeners', async () => {
  const t = await setup();
  try {
    assert(
      (await Deno.resolveDns('melofon.home', 'A')).every((ip) =>
        !ip.startsWith('127.')
      ),
    );
    const login = await t.f.login('bearer');
    const added = await t.playback.queueAddSources([
      catalogMedia(t.songs[0]),
      web('station'),
      web(),
    ], { play: true });
    const queue = await (await t.own('/api/queue')).json();
    assertEquals(queue.count, 3);
    assertEquals(queue.items[0].track_id, wireInt(t.songs[0].id));
    assertEquals(queue.items[0].uri, `library:track:${wireInt(t.songs[0].id)}`);
    assertEquals(
      queue.items.map((row: { id: number }) => row.id),
      added.map((row) => row.id),
    );
    for (const row of queue.items.slice(1)) {
      assertEquals(row.data_kind, 'http');
      assertEquals(row.title, 'Station name');
      assertEquals(row.length_ms, 0);
      for (
        const field of [
          'track_id',
          'album_id',
          'artist_id',
          'album_artist_id',
          'artwork_url',
        ]
      ) {
        assert(!(field in row), `fabricated ${field}`);
      }
    }
    assertEquals(queue.items[1].uri, 'http://melofon.home:1234/resolved');
    assertEquals(
      queue.items[2].uri,
      'http://melofon.home:1234/radio?token=private-query#station',
    );
    assertEquals((await t.rest())[0].id, t.songs[0].id);
    const artwork = await t.own('/artwork/nowplaying');
    assertEquals(artwork.status, 200);
    await artwork.body?.cancel();
    // Preserve a real catalog app report while the server changes source kind.
    await t.playback.reportPlaying({
      username: 'admin',
      client: 'Phone',
      trackId: t.songs[1].id,
      streamId: 'phone',
    });
    for (const index of [1, 2]) {
      await t.playback.next();
      const player = await (await t.own('/api/player')).json();
      assertEquals(player.item_id, added[index].id);
      const noCover = await t.own('/artwork/nowplaying');
      assertEquals(noCover.status, 404);
      await noCover.body?.cancel();
      const rows = await t.playback.nowPlayingView();
      const server = rows.find((row) => row.kind === 'server');
      assert(server?.facts.kind === 'web');
      assertEquals(server.facts.streamTitle, 'Artist - On air');
      assertEquals(server.facts.title, 'Station name');
      assertEquals((await t.rest()).map((row: { id: string }) => row.id), [
        t.songs[1].id,
      ]);
      const response = await t.f.get('/api/v1/now-playing', login.credential);
      assertEquals(response.status, 200);
      const body = await response.json();
      const remote = body.nowPlaying.find((row: { kind: string }) =>
        row.kind === 'server'
      );
      assert(!('song' in remote));
      assertEquals(remote.media, {
        kind: 'web',
        title: 'Station name',
        artistName: null,
        durationMs: null,
        mode: 'live',
        seekable: false,
        streamTitle: 'Artist - On air',
      });
      assert(!JSON.stringify(body).includes('private-query'));
      assertEquals(
        body.nowPlaying.find((row: { kind: string }) => row.kind === 'app').song
          .id,
        t.songs[1].id,
      );
    }
    await t.playback.previous();
    await t.playback.previous();
    assertEquals((await t.rest()).length, 2);
  } finally {
    await t.close();
  }
});

Deno.test('typed queue: duplicate sources retain independent occurrence ids and insertion preserves current', async () => {
  const t = await setup();
  try {
    const source = web();
    const added = await t.playback.queueAddSources([source, source], {
      play: true,
    });
    assertEquals(added.map((row) => row.reference), [
      source.reference,
      source.reference,
    ]);
    assert(added[0].id !== added[1].id);
    const inserted = await t.playback.queueAdd([t.songs[0]], { position: 0 });
    assertEquals(t.playback.playerView().current?.id, added[0].id);
    assertEquals(t.playback.queueView().items.map((row) => row.id), [
      inserted[0].id,
      added[0].id,
      added[1].id,
    ]);
    assertEquals(queueSong(inserted[0]), t.songs[0]);
    assertEquals(queueSong(added[0]), null);
    await t.playback.next();
    assertEquals(t.playback.playerView().current?.id, added[1].id);
    t.playback.queueClear();
    const next = await t.playback.queueAdd([t.songs[0]]);
    assert(next[0].id > inserted[0].id);
  } finally {
    await t.close();
  }
});

Deno.test('typed queue: persistence receives reference-only snapshots for remote replacement', async () => {
  const saved: QueueSnapshot[] = [];
  const t = await setup({
    saveQueue: (ids) => saved.push(ids),
    saveState() {},
  });
  try {
    await t.playback.queueAdd([t.songs[0]], { play: true });
    t.playback.pause();
    const added = await t.playback.queueAddSources([web()], {
      clear: true,
      play: true,
    });
    assertEquals(
      saved.at(-1)?.items,
      added.map(({ id, reference }) => ({ id, reference })),
    );
    assertEquals(saved.length, 2);
    assert(!JSON.stringify(saved).includes('On air'));
  } finally {
    await t.close();
  }
});

Deno.test('typed queue: finite facts drive existing duration clock without a catalog row', () => {
  let mono = 0;
  const player = createPlayer({ monotonicNow: () => mono });
  const media = web();
  assert(media.facts.kind === 'web');
  media.facts = { ...media.facts, mode: 'finite', durationMs: 1000 };
  const added = player.queueAddSources([media, web('station')]);
  player.play();
  mono = 500;
  assertEquals(player.status().itemLengthMs, 1000);
  assertEquals(player.status().itemProgressMs, 500);
  mono = 1000;
  assertEquals(player.advanceEnded(), 'player');
  assertEquals(player.status().current?.id, added[1].id);
  assertEquals(player.status().itemLengthMs, 0);
  assertEquals(player.advanceEnded(), 'none');
});

Deno.test('typed queue: OwnTone URL admission stays closed and preserves a noncatalog core queue on rejection', async () => {
  const t = await setup();
  try {
    await t.playback.queueAddSources([web('station')], { play: true });
    const before = t.playback.queueView();
    const query = new URLSearchParams({
      uris: 'http://melofon.home:1234/audio',
      clear: 'true',
      playback: 'start',
    });
    const response = await t.own(`/api/queue/items/add?${query}`, 'POST');
    assertEquals(response.status, 400);
    await response.body?.cancel();
    assertEquals(t.playback.queueView(), before);
    assertEquals((await (await t.own('/api/queue')).json()).count, 1);
  } finally {
    await t.close();
  }
});

Deno.test('typed queue: mixed references, permanent ids and bookmark survive reopen into fresh HTTP services', async () => {
  const first = await setup(true);
  const station = await first.f.store.radio.create({
    name: 'Original',
    streamUrl: 'http://melofon.home/original',
    homePageUrl: null,
  });
  const source = web('station');
  source.reference = { kind: 'station', id: station.id };
  const added = await first.playback.queueAddSources([
    catalogMedia(first.songs[0]),
    source,
    web(),
    source,
  ], { play: true });
  await first.playback.seek({ positionMs: 123 });
  first.playback.pause();
  const before = first.playback.playerView().itemProgressMs;
  const original = first.playback.queueView();
  await first.close(true);
  const second = await setup(true, first.dir);
  try {
    const queue = await second.durable!.loadQueue();
    assertEquals(
      queue.items,
      added.map(({ id, reference }) => ({ id, reference })),
    );
    assertEquals(queue.version, original.version);
    const snapshot = await planRestore({
      queue,
      saved: await second.durable!.loadPlayerState(),
      resolve: createQueueResolver({
        getSong: createLibrary(second.f.store).getSong,
        getStation: second.f.store.radio.get,
      }),
      nowMs: Date.now(),
      maxAgeMs: 300000,
      selectedOutputPresent: true,
    });
    assert(snapshot);
    await second.playback.restore(snapshot);
    const wire = await (await second.own('/api/queue')).json();
    assertEquals(
      wire.items.map((e: { id: number }) => e.id),
      added.map((e) => e.id),
    );
    assertEquals(wire.items[1].title, 'Original');
    assert(!('album' in wire.items[1]));
    assertEquals(second.playback.playerView().itemProgressMs, before);
    assertEquals(second.playback.queueView().version, original.version);
    const rows = second.playback.queueView().items;
    for (const row of rows.slice(1)) {
      assert(row.facts.kind === 'web');
      assertEquals(row.facts.streamTitle, null);
      assertEquals(row.facts.streamUrl, null);
      assertEquals(row.facts.durationMs, null);
    }
    const next = await second.playback.queueAdd([second.songs[0]]);
    assert(next[0].id > Math.max(...added.map((e) => e.id)));
    second.playback.queueClear();
    await second.durable!.drain();
    const empty = await second.durable!.loadQueue();
    const player = createPlayer();
    const emptyRestore = await planRestore({
      queue: empty,
      saved: await second.durable!.loadPlayerState(),
      resolve: () => Promise.resolve(null),
      nowMs: Date.now(),
      maxAgeMs: 300000,
      selectedOutputPresent: false,
    });
    assert(emptyRestore);
    player.restore(emptyRestore);
    assert(player.queueAdd([second.songs[0]])[0].id > next[0].id);
  } finally {
    await second.close();
  }
});

Deno.test('typed queue: station edits wait for activation, deleted stations skip and repeat-all is bounded', async () => {
  const t = await setup(true);
  try {
    const station = await t.f.store.radio.create({
      name: 'Before',
      streamUrl: 'http://melofon.home/before',
      homePageUrl: null,
    });
    const source = web('station');
    source.reference = { kind: 'station', id: station.id };
    const added = await t.playback.queueAddSources([
      source,
      source,
      catalogMedia(t.songs[0]),
    ], { play: true });
    assertEquals(
      (await (await t.own('/api/queue')).json()).items[0].title,
      'Before',
    );
    await t.f.store.radio.update(station.id, {
      name: 'After',
      streamUrl: 'http://melofon.home/after',
      homePageUrl: null,
    });
    assertEquals(
      (await (await t.own('/api/queue')).json()).items[0].uri,
      'http://melofon.home/before',
    );
    await t.playback.queueAdd([t.songs[1]], { play: true });
    const unchanged = t.playback.playerView().current;
    assert(unchanged?.facts.kind === 'web');
    assertEquals(unchanged.facts.url, 'http://melofon.home/before');
    await t.playback.next();
    const current = t.playback.playerView().current;
    assert(current?.facts.kind === 'web');
    assertEquals(current.id, added[1].id);
    assertEquals(current.facts.url, 'http://melofon.home/after');
    assertEquals(current.facts.title, 'After');
    await t.f.store.radio.delete(station.id);
    assertEquals(
      t.playback.playerView().current,
      current,
      'deletion does not interrupt current run',
    );
    await t.playback.previous();
    assertEquals(t.playback.playerView().state, 'stop');
    await t.playback.play();
    assertEquals(
      (await (await t.own('/api/player')).json()).item_id,
      added[2].id,
    );
    await t.playback.queueAddSources([source, source], { clear: true });
    t.playback.setRepeat('all');
    await t.playback.play();
    assertEquals((await (await t.own('/api/player')).json()).state, 'stop');
  } finally {
    await t.close();
  }
});

Deno.test('typed queue: a newer clear cancels pending station resolution before any stale activation', async () => {
  const t = await setup();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const started = new Promise<void>((resolve) => entered = resolve);
  const core = createPlayback({
    player: createPlayer(),
    nowPlaying: createNowPlaying(t.f.store),
    library: createLibrary(t.f.store),
    cfg: {},
    resolveQueueReference: async () => {
      entered();
      await gate;
      return web('station');
    },
  });
  try {
    await core.queueAddSources([web('station')]);
    const pending = core.play();
    await started;
    core.queueClear();
    release();
    await assertRejects(
      () => Promise.resolve(pending),
      Error,
      'Playback start cancelled',
    );
    assertEquals(core.queueView().items, []);
    assertEquals(core.playerView().state, 'stop');
  } finally {
    release();
    await core.close();
    await t.close();
  }
});

Deno.test('typed queue: natural and consume transitions resolve and skip stations before publishing current', async () => {
  const t = await setup();
  let mono = 0;
  const core = createPlayback({
    player: createPlayer({ monotonicNow: () => mono }),
    nowPlaying: createNowPlaying(t.f.store),
    library: createLibrary(t.f.store),
    cfg: {},
    resolveQueueReference: createQueueResolver({
      getSong: createLibrary(t.f.store).getSong,
      getStation: t.f.store.radio.get,
    }),
  });
  try {
    for (const consume of [false, true]) {
      const short = { ...t.songs[0], durationMs: 10 };
      const added = await core.queueAddSources([
        catalogMedia(short),
        web('station'),
        catalogMedia(t.songs[1]),
      ], { clear: true, play: true });
      core.setConsume(consume);
      mono += 10;
      await core.advanceEnded();
      assertEquals(core.playerView().current?.id, added[2].id);
      assertEquals(core.queueView().items.length, consume ? 2 : 3);
    }
  } finally {
    await core.close();
    await t.close();
  }
});
