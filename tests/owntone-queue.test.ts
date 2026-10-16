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

const HOOK = 3689;
const DEFAULT_PORT = 4534;

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-otq-' });
  const store = await openStore(dir);
  const db = store.legacy;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(db);
  const library = createLibrary(db);
  const playlists = createPlaylists(db);
  const albums = await library.listAlbums({
    sort: 'name',
    size: 10,
    offset: 0,
  });
  const fixtureAlbum = await library.getAlbum(albums[0].id);
  await playlists.create('admin', 'Mix', [fixtureAlbum!.songs[0].id]);
  const notify = createNotify();
  const player = createPlayer();
  const bag = {
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
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const get = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`));
const post = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`, { method: 'POST' }));

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

Deno.test('genre uri expands by genre; unknown genre 404; http stays 400', async () => {
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
        '/api/queue/items/add?uris=http://10.4.20.208:8096/Items/x/Images/Primary/jpg',
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
