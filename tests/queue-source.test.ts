import { assert, assertEquals, assertThrows } from '@std/assert';
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
  queueSong,
} from '../src/queue-source.ts';
import { wireInt } from '../layers/owntone/payloads.ts';

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

async function setup(persistence?: PlayerPersistence) {
  const dir = await restored('queue-source', async (dir) => {
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
  const f = await apiFixture({
    storeDir: dir,
    hats: {
      layersRoot: 'layers',
      extraPorts: 1,
      env: ([port]) => ({ MELOFON_LISTEN_owntone: `${port},${port}` }),
    },
    services: (f) => {
      const library = createLibrary(f.store);
      playback = createPlayback({
        player: createPlayer(),
        library,
        nowPlaying: createNowPlaying(f.store),
        cfg: f.cfg,
        notify: f.notify,
        persistence,
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
    async close() {
      await playback.close();
      await f.close();
      await Deno.remove(dir, { recursive: true });
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

Deno.test('typed queue: legacy persistence refuses remote replacement before losing the queue or bookmark', async () => {
  const saved: string[][] = [];
  const t = await setup({
    saveQueue: (ids) => saved.push(ids),
    saveState() {},
  });
  try {
    await t.playback.queueAdd([t.songs[0]], { play: true });
    t.playback.pause();
    const before = t.playback.queueView();
    const state = t.playback.playerView();
    assertThrows(
      () => t.playback.queueAddSources([web()], { clear: true, play: true }),
      Error,
      'Typed queue persistence',
    );
    assertEquals(t.playback.queueView(), before);
    assertEquals(t.playback.playerView(), state);
    assertEquals(saved, [[t.songs[0].id]]);
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
