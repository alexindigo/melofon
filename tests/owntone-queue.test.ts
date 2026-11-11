// tests/owntone-queue.test.ts — HA-shaped queue adds: playlist / artist /
// genre URIs expand in the hat, position/playback_from_position are core
// playback commands. Fixture library + a seeded playlist ("Mix", one track).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createNotify } from '../src/notify.ts';
import { createBinds } from '../src/binds.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { restored } from './helpers/prepared.ts';

const HOOK = 3689;
const DEFAULT_PORT = 4534;

function config(dir: string) {
  return {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
}

async function setup() {
  const dir = await restored('owntone-queue', async (dir) => {
    const store = await openStore(dir);
    try {
      await seedFirstUser(store, config(dir));
      const libraries = createLibraries(store);
      await libraries.add(
        'Music',
        await Deno.realPath('tests/fixtures/library'),
      );
      await scanLibrary(store);
    } finally {
      await store.close();
    }
  }, 'melofon-otq-');
  const store = await openStore(dir);
  const db = store;
  const cfg = config(dir);
  const libraries = createLibraries(store);
  const library = createLibrary(store);
  const playlists = createPlaylists(store);
  const albums = await library.listAlbums({
    sort: 'name',
    size: 10,
    offset: 0,
  });
  const fixtureAlbum = await library.getAlbum(albums[0].id);
  await playlists.create('admin', 'Mix', [fixtureAlbum!.songs[0].id]);
  const notify = createNotify();
  const player = createPlayer();
  const state = createState(store);
  const bag = {
    state,
    cfg,
    libraries,
    library,
    playlists,
    player,
    outputs: createOutputs({ notify }),
    playback: createPlayback({
      player,
      nowPlaying: createNowPlaying(store),
      library,
      cfg,
      notify,
      state,
    }),
    notify,
    binds: createBinds(() => layers, {}),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const layers = await loadLayers({ app: bag });
  const app = facade(core, layers, {
    listenPort: HOOK,
    defaultPort: DEFAULT_PORT,
    env: {},
  });
  return {
    app,
    state,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const get = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`));
const post = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`, { method: 'POST' }));

Deno.test('OwnTone queue add keeps its wire reply and refuses overflow without clear, playback or shuffle changes', async () => {
  const { app, state, close } = await setup();
  const server = Deno.serve(
    { hostname: '0.0.0.0', port: 0, onListen() {} },
    app,
  );
  const base = `http://melofon.home:${server.addr.port}`;
  const json = async (path: string, method = 'GET') => {
    const response = await fetch(`${base}${path}`, { method });
    assertEquals(response.status, 200);
    return await response.json();
  };
  try {
    const artists = await json('/api/library/artists');
    const artist = artists.items.find((a: { name: string }) =>
      a.name === 'Fixture Artist'
    );
    const albumList = await json('/api/library/albums');
    const tracks = await json(
      `/api/library/albums/${albumList.items[0].id}/tracks`,
    );
    const uri = `library:track:${tracks.items[0].id}`;
    await state.set('playback.queueLimit', '2');
    const added = await json(`/api/queue/items/add?uris=${uri},${uri}`, 'POST');
    assertEquals(Object.keys(added).sort(), ['count', 'items', 'version']);
    assertEquals(added.count, 2);
    const before = await json('/api/queue');
    const player = await json('/api/player');
    for (
      const query of [
        `uris=${uri}`,
        `uris=${artist.uri}&clear=true&playback=start&shuffle=true`,
      ]
    ) {
      const refusal = await fetch(`${base}/api/queue/items/add?${query}`, {
        method: 'POST',
      });
      assertEquals(refusal.status, 500);
      assertEquals(await refusal.text(), 'Queue limit is 2 entries');
      assertEquals(await json('/api/queue'), before);
      assertEquals(await json('/api/player'), player);
    }
    assertEquals(
      (await json(`/api/queue/items/add?uris=${uri}&clear=true`, 'POST')).count,
      1,
    );
  } finally {
    await server.shutdown();
    await close();
  }
});

for (const position of [undefined, 3, 10, 25]) {
  Deno.test(`add reply matches queue entries at position ${position ?? 'omitted'} with clear/shuffle/playback`, async () => {
    const { app, close } = await setup();
    const server = Deno.serve(
      { hostname: '0.0.0.0', port: 0, onListen() {} },
      app,
    );
    const base = `http://melofon.home:${server.addr.port}`;
    const json = async (path: string, method = 'GET') => {
      const response = await fetch(`${base}${path}`, { method });
      assertEquals(response.status, 200);
      return await response.json();
    };
    try {
      const library = await json('/api/library/albums');
      const tracks = await json(
        `/api/library/albums/${library.items[0].id}/tracks`,
      );
      const uri = `library:track:${tracks.items[0].id}`;
      // Repeated songs require matching queue entry ids, not library track ids.
      const seed = Array(10).fill(uri).join(',');
      for (const clear of [false, true]) {
        for (const shuffle of [undefined, false, true]) {
          for (const play of [false, true]) {
            await json(`/api/queue/items/add?uris=${seed}&clear=true`, 'POST');
            const before = await json('/api/queue');
            assertEquals(before.count, 10);
            const query = new URLSearchParams({
              uris: `${uri},${uri}`,
              clear: String(clear),
            });
            if (position !== undefined) query.set('position', String(position));
            if (shuffle !== undefined) query.set('shuffle', String(shuffle));
            if (play) query.set('playback', 'start');
            const added = await json(`/api/queue/items/add?${query}`, 'POST');
            const queue = await json('/api/queue');
            assertEquals(added.version, queue.version);
            assertEquals(added.version, before.version + (clear ? 2 : 1));
            assertEquals(added.count, 2);
            assertEquals(queue.count, clear ? 2 : 12);
            const start = clear ? 0 : Math.min(position ?? 10, 10);
            assertEquals(
              added.items.map((item: { position: number }) => item.position),
              [start, start + 1],
            );
            assertEquals(
              new Set(added.items.map((item: { id: number }) => item.id)).size,
              2,
            );
            for (const item of added.items) {
              const index = queue.items.findIndex((entry: { id: number }) =>
                entry.id === item.id
              );
              assert(index >= 0);
              assertEquals(item.position, index);
              assertEquals(item, queue.items[index]);
            }
            if (play) {
              assertEquals((await json('/api/player')).state, 'play');
            }
          }
        }
      }
    } finally {
      await server.shutdown();
      await close();
    }
  });
}

async function albums(app: (r: Request) => Promise<Response>) {
  return await (await get(app, '/api/library/albums')).json();
}

Deno.test('playlist uri expands to the playlist tracks and starts playing', async () => {
  const { app, close } = await setup();
  try {
    const playlists = await (await get(app, '/api/library/playlists')).json();
    const wire = playlists.items[0].uri.split(':').pop();
    const res = await post(
      app,
      `/api/queue/items/add?uris=library:playlist:${wire}` +
        '&playback=start&clear=true',
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.count, 1);
    const queue = await (await get(app, '/api/queue')).json();
    assertEquals(queue.count, 1);
    const player = await (await get(app, '/api/player')).json();
    assertEquals(player.state, 'play');
    assert(
      queue.items.some((i: { id: number }) => i.id === player.item_id),
      'item_id is a real queue id',
    );
    // Unknown playlist → 404.
    assertEquals(
      (await post(app, '/api/queue/items/add?uris=library:playlist:1')).status,
      404,
    );
  } finally {
    await close();
  }
});

Deno.test('artist uri expands to every track of that artist', async () => {
  const { app, close } = await setup();
  try {
    const artists = await (await get(app, '/api/library/artists')).json();
    const fixture = artists.items.find(
      (a: { name: string }) => a.name === 'Fixture Artist',
    );
    const wire = fixture.uri.split(':').pop();
    const res = await post(
      app,
      `/api/queue/items/add?uris=library:artist:${wire}&clear=true`,
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.count, 3); // First Song, Second Song, Clip
    const queue = await (await get(app, '/api/queue')).json();
    assertEquals(
      queue.items.map((i: { title: string }) => i.title),
      ['First Song', 'Second Song', 'Clip'],
    );
    assertEquals(
      (await post(app, '/api/queue/items/add?uris=library:artist:1')).status,
      404,
    );
  } finally {
    await close();
  }
});

Deno.test('genre uri expands by genre; unknown genre 404; unsupported scheme stays 400', async () => {
  const { app, close } = await setup();
  try {
    const res = await post(
      app,
      `/api/queue/items/add?uris=${
        encodeURIComponent('library:genre:Fixture Rock')
      }&clear=true`,
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).count, 2);
    assertEquals(
      (await post(
        app,
        `/api/queue/items/add?uris=${
          encodeURIComponent('library:genre:Nope Genre')
        }`,
      ))
        .status,
      404,
    );
    assertEquals(
      (await post(
        app,
        '/api/queue/items/add?uris=ftp://melofon.home/audio',
      ))
        .status,
      400,
    );
  } finally {
    await close();
  }
});

Deno.test('position inserts; playback_from_position starts at that index', async () => {
  const { app, close } = await setup();
  try {
    // Queue the album (3 tracks), then insert a track at position 1.
    const abs = await albums(app);
    const albumWire = abs.items[0].uri.split(':').pop();
    await post(
      app,
      `/api/queue/items/add?uris=library:album:${albumWire}&clear=true`,
    );
    const tracks = await (await get(
      app,
      `/api/library/albums/${abs.items[0].id}/tracks`,
    )).json();
    const trackWire = tracks.items[2].id; // Clip
    const res = await post(
      app,
      `/api/queue/items/add?uris=library:track:${trackWire}&position=1`,
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.items[0].position, 1);

    const queue = await (await get(app, '/api/queue')).json();
    assertEquals(
      queue.items.map((i: { title: string }) => i.title),
      ['First Song', 'Clip', 'Second Song', 'Clip'],
    );

    // playback_from_position starts exactly that index.
    await post(
      app,
      `/api/queue/items/add?uris=library:track:${tracks.items[0].id}` +
        '&playback=start&playback_from_position=1',
    );
    const player = await (await get(app, '/api/player')).json();
    assertEquals(player.state, 'play');
    assertEquals(player.item_id, queue.items[1].id);
  } finally {
    await close();
  }
});
