// tests/owntone-library.test.ts — OwnTone library browse + search against
// the fixture library (in-process facade on the 3689 hook): stats, count,
// artists, tracks, genres, playlists (seeded user's), search. db_playtime is
// SECONDS (probed httpd_jsonapi.c: length / 1000). Search `type` is
// substring-matched like OwnTone's C (track ≡ tracks).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openDb } from '../src/db.ts';
import { seedFirstUser } from '../src/users.ts';
import { createScan } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createNotify } from '../src/notify.ts';
import { createBinds } from '../src/binds.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';

const HOOK = 3689;
const DEFAULT_PORT = 4534;
const STARTED_AT = '2026-09-18T12:00:00.000Z';

async function setup(
  opts: { seedUser?: boolean; withPlaylist?: boolean } = {},
) {
  const { seedUser = true, withPlaylist = true } = opts;
  const dir = await Deno.makeTempDir({ prefix: 'melofon-otlib-' });
  const db = await openDb(dir);
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: seedUser ? 'admin' : undefined,
    password: seedUser ? 'test' : undefined,
    secret: 's3cret',
    version: '0.0.0-test',
  };
  if (seedUser) await seedFirstUser(db, cfg);
  const libraries = createLibraries(db);
  await libraries.add('Music', 'tests/fixtures/library');
  const scan = createScan(db);
  await scan.run();
  const library = createLibrary(db);
  const playlists = createPlaylists(db);
  if (withPlaylist && seedUser) {
    const albums = await library.listAlbums({
      sort: 'name',
      size: 10,
      offset: 0,
    });
    const got = await library.getAlbum(albums[0].id);
    await playlists.create('admin', 'Mix', [got!.songs[0].id]);
  }
  const notify = createNotify();
  const bag = {
    cfg,
    startedAt: STARTED_AT,
    libraries,
    library,
    scan,
    playlists,
    player: createPlayer({ notify }),
    outputs: createOutputs({ notify }),
    notify,
    binds: createBinds(() => layers, {}),
  };
  const core = await pathfinder({ roots: ['core/'], app: { db, cfg } });
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

Deno.test('GET /api/library: stats with db_playtime in SECONDS', async () => {
  const { app, close } = await setup();
  try {
    const res = await get(app, '/api/library');
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.songs, 4);
    assertEquals(body.artists, 2);
    assertEquals(body.albums, 2);
    assertEquals(typeof body.db_playtime, 'number');
    // Seconds, not milliseconds: the fixture is ~20s of audio, not ~5 hours.
    assert(
      body.db_playtime < 1000,
      `db_playtime ${body.db_playtime} is seconds`,
    );
    assertEquals(body.started_at, STARTED_AT);
    assert(
      typeof body.updated_at === 'string' && body.updated_at.endsWith('Z'),
    );
    assertEquals(body.updating, false);
  } finally {
    await close();
  }
});

Deno.test('GET /api/library/count: counts, pipe expression → zeros, other → 400', async () => {
  const { app, close } = await setup();
  try {
    const res = await get(app, '/api/library/count');
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.tracks, 4);
    assertEquals(body.artists, 2);
    assertEquals(body.albums, 2);
    assert(body.db_playtime < 1000);

    const pipe = await get(
      app,
      '/api/library/count?expression=data_kind+is+pipe',
    );
    assertEquals(pipe.status, 200);
    assertEquals(await pipe.json(), {
      tracks: 0,
      artists: 0,
      albums: 0,
      db_playtime: 0,
    });

    assertEquals(
      (await get(app, '/api/library/count?expression=genre+is+%22Pop%22'))
        .status,
      400,
    );
  } finally {
    await close();
  }
});

Deno.test('artists: list with paging, one by id, albums of an artist', async () => {
  const { app, close } = await setup();
  try {
    const res = await get(app, '/api/library/artists');
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.total, 2);
    assertEquals(body.offset, 0);
    assertEquals(body.limit, -1);
    assertEquals(
      body.items.map((a: { name: string }) => a.name),
      ['Fixture Artist', 'Various Artists'],
    );
    const fixture = body.items[0];
    assert(/^\d+$/.test(fixture.id));
    assertEquals(fixture.album_count, 1);
    assertEquals(fixture.track_count, 3);
    assert(fixture.length_ms > 0);
    assertEquals(fixture.uri, `library:artist:${fixture.id}`);

    // Paging slices in the hat.
    const page = await get(app, '/api/library/artists?offset=1&limit=1');
    const pbody = await page.json();
    assertEquals(pbody.total, 2);
    assertEquals(pbody.items.length, 1);
    assertEquals(pbody.items[0].name, 'Various Artists');

    // One artist by wire id.
    const one = await get(app, `/api/library/artists/${fixture.id}`);
    assertEquals(one.status, 200);
    assertEquals((await one.json()).name, 'Fixture Artist');

    // Albums of the artist.
    const albums = await get(app, `/api/library/artists/${fixture.id}/albums`);
    const abody = await albums.json();
    assertEquals(abody.total, 1);
    assertEquals(abody.items[0].name, 'Fixture Album');

    // Unknown / malformed.
    assertEquals((await get(app, '/api/library/artists/1')).status, 404);
    assertEquals((await get(app, '/api/library/artists/abc')).status, 400);
  } finally {
    await close();
  }
});

Deno.test('GET /api/library/tracks/<wire>: the track object', async () => {
  const { app, close } = await setup();
  try {
    const albums = await (await get(app, '/api/library/albums')).json();
    const tracks = await (await get(
      app,
      `/api/library/albums/${albums.items[0].id}/tracks`,
    )).json();
    const wire = tracks.items[0].id;

    const res = await get(app, `/api/library/tracks/${wire}`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.id, wire);
    assertEquals(body.title, 'First Song');
    assertEquals(body.artist, 'Fixture Artist');
    assertEquals(body.album, 'Fixture Album');
    assertEquals(body.album_artist, 'Fixture Artist');
    assert(/^\d+$/.test(body.album_id));
    assertEquals(body.uri, `library:track:${wire}`);
    assertEquals(body.data_kind, 'file');
    assertEquals(body.media_kind, 'music');

    assertEquals((await get(app, '/api/library/tracks/1')).status, 404);
    assertEquals((await get(app, '/api/library/tracks/abc')).status, 400);
  } finally {
    await close();
  }
});

Deno.test('GET /api/library/genres: browse-info paging', async () => {
  const { app, close } = await setup();
  try {
    const res = await get(app, '/api/library/genres');
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.total, 2);
    assertEquals(body.items, [
      { name: 'Fixture Rock' },
      { name: 'Fixture Soundtrack' },
    ]);
  } finally {
    await close();
  }
});

Deno.test('playlists: seeded user list, one by id, its tracks; unset user → empty', async () => {
  const { app, close } = await setup();
  try {
    const res = await get(app, '/api/library/playlists');
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.total, 1);
    const pl = body.items[0];
    assertEquals(pl.name, 'Mix');
    assertEquals(typeof pl.id, 'number'); // playlist ids are numbers in OwnTone
    assertEquals(pl.type, 'plain');
    assertEquals(pl.smart_playlist, false);
    assertEquals(pl.folder, false);
    assertEquals(pl.item_count, 1);
    assertEquals(pl.uri, `library:playlist:${pl.id}`);

    const one = await get(app, `/api/library/playlists/${pl.id}`);
    assertEquals(one.status, 200);
    assertEquals((await one.json()).name, 'Mix');

    const tracks = await get(app, `/api/library/playlists/${pl.id}/tracks`);
    const tbody = await tracks.json();
    assertEquals(tbody.total, 1);
    assertEquals(tbody.items[0].title, 'First Song');

    assertEquals((await get(app, '/api/library/playlists/1')).status, 404);
    assertEquals((await get(app, '/api/library/playlists/abc')).status, 400);
  } finally {
    await close();
  }

  const empty = await setup({ seedUser: false, withPlaylist: false });
  try {
    const res = await get(empty.app, '/api/library/playlists');
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      items: [],
      total: 0,
      offset: 0,
      limit: -1,
    });
  } finally {
    await empty.close();
  }
});

Deno.test('search: type substring matching (track ≡ tracks), all result kinds', async () => {
  const { app, close } = await setup();
  try {
    // HA's spelling: type=tracks.
    const res = await get(app, '/api/search?type=tracks&query=First');
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.tracks.total, 1);
    assertEquals(body.tracks.items[0].title, 'First Song');
    assertEquals(body.artists, undefined); // only requested kinds appear

    // Singular spelling hits the same substring.
    const singular = await get(app, '/api/search?type=track&query=First');
    assertEquals((await singular.json()).tracks.total, 1);

    // All kinds in one request.
    const all = await get(
      app,
      '/api/search?type=tracks,artists,albums,playlists,genres,composers&query=Fixture',
    );
    const abody = await all.json();
    assertEquals(abody.artists.items[0].name, 'Fixture Artist');
    assertEquals(abody.albums.total, 2); // Fixture Album + Fixture OST
    assertEquals(abody.albums.items[0].name, 'Fixture Album');
    // search3 matches song TITLES — no fixture title contains "Fixture".
    assertEquals(abody.tracks.total, 0);
    assertEquals(abody.playlists.total, 0); // "Mix" does not contain "Fixture"
    assertEquals(abody.genres.items, [
      { name: 'Fixture Rock' },
      { name: 'Fixture Soundtrack' },
    ]);
    assertEquals(abody.composers, {
      items: [],
      total: 0,
      offset: 0,
      limit: -1,
    });

    // Playlist name filter.
    const pls = await get(app, '/api/search?type=playlists&query=Mix');
    assertEquals((await pls.json()).playlists.total, 1);

    // expression: pipe → empty, anything else → 400; missing params → 400.
    const pipe = await get(
      app,
      '/api/search?type=tracks&expression=data_kind+is+pipe',
    );
    assertEquals((await pipe.json()).tracks, {
      items: [],
      total: 0,
      offset: 0,
      limit: -1,
    });
    assertEquals(
      (await get(app, '/api/search?type=tracks&expression=genre+is+%22Pop%22'))
        .status,
      400,
    );
    assertEquals((await get(app, '/api/search?query=x')).status, 400);
    assertEquals((await get(app, '/api/search?type=tracks')).status, 400);
  } finally {
    await close();
  }
});
