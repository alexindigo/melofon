// tests/owntone-library.test.ts — OwnTone library browse + search against
// the fixture library (in-process facade on the 3689 hook): stats, count,
// artists, tracks, genres, playlists (seeded user's), search. db_playtime is
// SECONDS (probed httpd_jsonapi.c: length / 1000). Search `type` is
// substring-matched like OwnTone's C (track ≡ tracks).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createScan } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createFolders } from '../src/folders.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createArtwork } from '../src/artwork.ts';
import { createOutputs, createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createNotify } from '../src/notify.ts';
import { createBinds } from '../src/binds.ts';
import { facade } from '../src/facade.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { apiFixture } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';

const HOOK = 3689;
const DEFAULT_PORT = 4534;
const STARTED_AT = '2026-09-18T12:00:00.000Z';

async function setup(
  opts: { seedUser?: boolean; withPlaylist?: boolean } = {},
) {
  const { seedUser = true, withPlaylist = true } = opts;
  const dir = await Deno.makeTempDir({ prefix: 'melofon-otlib-' });
  const store = await openStore(dir);
  const db = store;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: seedUser ? 'admin' : undefined,
    password: seedUser ? 'test' : undefined,
    secret: 's3cret',
    version: '0.0.0-test',
  };
  if (seedUser) await seedFirstUser(store, cfg);
  const libraries = createLibraries(store);
  await libraries.add('Music', await Deno.realPath('tests/fixtures/library'));
  const scan = createScan(store);
  await scan.run();
  const library = createLibrary(store);
  const playlists = createPlaylists(store);
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
  const player = createPlayer();
  const nowPlaying = createNowPlaying(store);
  const bag = {
    state: createState(store),
    cfg,
    startedAt: STARTED_AT,
    libraries,
    library,
    folders: createFolders(store),
    scan,
    playlists,
    artwork: createArtwork(library),
    player,
    outputs: createOutputs({ notify }),
    playback: createPlayback({ player, nowPlaying, library, cfg }),
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
  const onDefault = facade(core, layers);
  return {
    app,
    onDefault,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

const get = (app: (r: Request) => Promise<Response>, path: string) =>
  app(new Request(`http://x${path}`));

/** Both real protocol listens share the same core owners. Reject the former
 * hat-side catalog reconstruction so an HTTP success proves adoption too. */
async function coreBrowseFixture(empty = false) {
  const root = await Deno.makeTempDir({ prefix: 'melofon-own-core-' });
  const folderCalls: Parameters<
    ReturnType<typeof createFolders>['browse']
  >[0][] = [];
  try {
    const f = await apiFixture({
      allLayers: true,
      hats: {
        layersRoot: 'layers',
        extraPorts: 2,
        env: (ports) => ({ MELOFON_LISTEN_owntone: ports.join(',') }),
      },
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        const scan = createScan(f.store);
        if (!empty) {
          for (const name of ['Music', 'Second', 'Empty']) {
            await Deno.mkdir(`${root}/${name}`);
            await libraries.add(name, `${root}/${name}`);
          }
          const files = [
            ['Music/z_root.mp3', {}],
            ['Music/a_root.mp3', { TALB: 'Root', TPE1: 'A' }],
            ['Music/Shared/a.mp3', { TALB: 'Compilation', TPE1: 'A' }],
            ['Music/Shared/z.mp3', { TALB: 'Compilation', TPE1: 'B' }],
            ['Music/Shared/deep/file.mp3', { TALB: 'Deep', TPE1: 'A' }],
            ['Second/Shared/file.mp3', {
              TALB: 'Other',
              TPE2: 'A',
              TPE1: 'Other',
            }],
            ['Music/Tagged/file.mp3', {
              TALB: 'Tagged',
              TPE2: 'Various Artists',
              TPE1: 'Guest',
            }],
          ] as const;
          for (const [i, [path, tags]] of files.entries()) {
            await Deno.mkdir(
              `${root}/${path.slice(0, path.lastIndexOf('/'))}`,
              {
                recursive: true,
              },
            );
            await tagged(`${root}/${path}`, {
              ...tags,
              TIT2: `Title ${20 - i}`,
            });
          }
          await Deno.mkdir(`${root}/Music/No media`);
          await scan.run();
        }
        const library = createLibrary(f.store);
        const folders = createFolders(f.store);
        const noWalk = () => {
          throw new Error('OwnTone must use core browse/statistics');
        };
        return {
          libraries,
          scan,
          startedAt: STARTED_AT,
          library: {
            ...library,
            listSongs: noWalk,
            listAlbums: noWalk,
            listArtists: noWalk,
            albumsWithoutArtist: noWalk,
          },
          folders: {
            browse: (options: Parameters<typeof folders.browse>[0]) => {
              folderCalls.push(options);
              return folders.browse(options);
            },
          },
        };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    const own = async (path: string) => {
      const response = await fetch(
        `http://melofon.home:${f.extraPorts[0]}${path}`,
        {
          signal: AbortSignal.timeout(5000),
        },
      );
      assertEquals(response.status, 200, await response.clone().text());
      return response.json();
    };
    return {
      ...f,
      root,
      own,
      folderCalls,
      async close() {
        await f.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (error) {
    await Deno.remove(root, { recursive: true });
    throw error;
  }
}

Deno.test('OwnTone core folders: absolute paths, independent directories, bounded track pages and native parity over HTTP', async () => {
  const f = await coreBrowseFixture();
  try {
    for (const name of ['🚀', '\uE000']) {
      await Deno.mkdir(`${f.root}/Music/${name}`);
      await tagged(`${f.root}/Music/${name}/file.mp3`, {});
    }
    await createScan(f.store).run();
    const libraries = await f.store.catalog.listLibraries();
    const music = libraries.find((l) => l.name === 'Music')!;
    const files = (directory?: string, page: Record<string, string> = {}) =>
      f.own(
        `/api/library/files?${new URLSearchParams({
          ...(directory === undefined ? {} : { directory }),
          ...page,
        })}`,
      );
    assertEquals(
      (await files()).directories,
      libraries.map((l) => ({ path: l.path })),
    );
    const root = await files(music.path);
    assertEquals(root.directories, [
      { path: `${music.path}/Shared` },
      { path: `${music.path}/Tagged` },
      { path: `${music.path}/🚀` },
      { path: `${music.path}/\uE000` },
    ]);
    assertEquals(root.tracks.items.map((s: { title: string }) => s.title), [
      'Title 19',
      'Title 20',
    ]);
    assertEquals([root.tracks.total, root.tracks.offset, root.tracks.limit], [
      2,
      0,
      -1,
    ]);
    assertEquals(root.playlists, { items: [], total: 0, offset: 0, limit: -1 });
    const nested = await files(`${music.path}/Shared///`);
    assertEquals(nested.directories, [{ path: `${music.path}/Shared/deep` }]);
    assertEquals(nested.tracks.items.map((s: { title: string }) => s.title), [
      'Title 18',
      'Title 17',
    ]);
    for (
      const [offset, limit, expected] of [
        ['0', '1', [nested.tracks.items[0]]],
        ['1', '1', [nested.tracks.items[1]]],
        ['2', '1', []],
        ['0', '0', []],
        ['1', '-1', [nested.tracks.items[1]]],
        ['9007199254740993', '-1', []],
        ['0', '9007199254740993', nested.tracks.items],
      ] as const
    ) {
      const page = await files(`${music.path}/Shared`, { offset, limit });
      assertEquals(page.directories, nested.directories);
      assertEquals(page.tracks, {
        items: expected,
        total: 2,
        offset: Number(offset),
        limit: Number(limit),
      });
      assertEquals(page.playlists, {
        items: [],
        total: 0,
        offset: Number(offset),
        limit: Number(limit),
      });
    }
    assert(
      f.folderCalls.some((c) => c.songs.limit === 1 && c.songs.offset === 1),
    );
    for (
      const path of [
        'missing',
        'No media',
        '../Second',
        'Shared/../Tagged',
        'Shared//deep',
      ]
    ) {
      assertEquals(await files(`${music.path}/${path}`), {
        directories: [],
        tracks: { items: [], total: 0, offset: 0, limit: -1 },
        playlists: { items: [], total: 0, offset: 0, limit: -1 },
      });
    }
    assertEquals((await files(`${f.root}/Empty`)).tracks.total, 0);
    assertEquals(
      (await files(`${f.root}/Second/Shared`)).tracks.items[0].title,
      'Title 15',
    );
    const outside = await fetch(
      `http://melofon.home:${
        f.extraPorts[0]
      }/api/library/files?${new URLSearchParams({
        directory: `${music.path}ish`,
      })}`,
    );
    assertEquals(outside.status, 404);
    await outside.body?.cancel();
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const response = await f.get(
        `/api/v1/folders?${new URLSearchParams({
          library: music.id,
          path: 'Shared',
          songLimit: '1',
          songOffset: '1',
        })}`,
        credential,
        { Origin: 'http://foreign.invalid' },
      );
      assertEquals(response.status, 200);
      const native = await response.json();
      assertEquals(native.folders.folders, [{
        libraryId: music.id,
        path: 'Shared/deep',
        name: 'deep',
      }]);
      assertEquals(native.songs.total, 2);
      assertEquals(native.songs.songs.map((s: { path: string }) => s.path), [
        'Shared/z.mp3',
      ]);
      assertEquals(native.songs.songs[0].title, nested.tracks.items[1].title);
      assert(!JSON.stringify(native).includes(music.path));
      assertEquals(native.tracks, undefined);
    }
  } finally {
    await f.close();
  }
});

Deno.test('Core folder addresses: native and OwnTone listings contain only openable paths with exact pages', async () => {
  const f = await coreBrowseFixture(true);
  try {
    const path = `${f.root}/Music`;
    await Deno.mkdir(path);
    const libraries = createLibraries(f.store);
    const music = await libraries.add('Music', path);
    const eligible = ['a', 'a/X:Y', 'a/1:ok', 'a/Z:more/deep', 'z'];
    const rejected = [
      'a\\b',
      'X:Y',
      'c:drive',
      'bad\nname',
      'bad\u007fname',
      'a/b\\c',
      'a/bad\tname',
    ];
    for (const folder of [...eligible, ...rejected]) {
      await Deno.mkdir(`${path}/${folder}`, { recursive: true });
      await tagged(`${path}/${folder}/song.mp3`, {});
    }
    // Only folder addresses are constrained, not immediate media basenames.
    await tagged(`${path}/root\\song.mp3`, {});
    await tagged(`${path}/Q:song.mp3`, {});
    await createScan(f.store).run();
    const own = (relative: string) =>
      f.own(`/api/library/files?${new URLSearchParams({
        directory: relative ? `${path}/${relative}` : path,
      })}`);
    const expected = new Map([
      ['', ['a', 'z']],
      ['a', ['a/1:ok', 'a/X:Y', 'a/Z:more']],
      ['a/1:ok', []],
      ['a/X:Y', []],
      ['a/Z:more', ['a/Z:more/deep']],
      ['a/Z:more/deep', []],
      ['z', []],
    ]);
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const native = async (relative: string, offset = 0, limit = 50) => {
        const response = await f.get(
          `/api/v1/folders?${new URLSearchParams({
            library: music.id,
            path: relative,
            folderOffset: String(offset),
            folderLimit: String(limit),
          })}`,
          credential,
        );
        assertEquals(response.status, 200, await response.clone().text());
        return response.json();
      };
      for (const [relative, children] of expected) {
        const page = await native(relative);
        assertEquals(page.folder.path, relative);
        assertEquals(
          page.folders.folders.map((r: { path: string }) => r.path),
          children,
        );
        assertEquals(page.folders.total, children.length);
        const ownPage = await own(relative);
        assertEquals(
          ownPage.directories,
          children.map((p) => ({ path: `${path}/${p}` })),
        );
        assertEquals(ownPage.tracks.total, page.songs.total);
        assert(page.songs.total > 0 || children.length > 0);
        for (let offset = 0; offset <= children.length; offset++) {
          const bounded = await native(relative, offset, 1);
          assertEquals(bounded.folders.total, children.length);
          assertEquals(
            bounded.folders.folders,
            page.folders.folders.slice(offset, offset + 1),
          );
        }
      }
      const root = await native('');
      assertEquals(root.songs.total, 2);
      for (const relative of rejected) {
        const response = await f.get(
          `/api/v1/folders?${new URLSearchParams({
            library: music.id,
            path: relative,
          })}`,
          credential,
        );
        assertEquals(response.status, 400);
        assertEquals((await response.json()).code, 'invalid_field');
        assertEquals((await own(relative)).directories, []);
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('OwnTone core statistics: placeholder population and live removal agree with native HTTP without catalog walks', async () => {
  const f = await coreBrowseFixture();
  try {
    const credentials = await Promise.all(
      (['cookie', 'bearer'] as const).map(async (use) =>
        (await f.login(use, 'listener', 'password-listener')).credential
      ),
    );
    const compare = async (count: number, artists: number) => {
      const summary = await f.own('/api/library');
      const counts = await f.own('/api/library/count');
      assertEquals(counts, {
        tracks: count,
        artists,
        albums: summary.albums,
        db_playtime: summary.db_playtime,
      });
      assertEquals(summary.songs, count);
      assertEquals(summary.artists, artists);
      assertEquals(summary.started_at, STARTED_AT);
      assertEquals(summary.updating, false);
      assert(typeof summary.updated_at === 'string');
      for (const credential of credentials) {
        const response = await f.get('/api/v1/statistics', credential);
        assertEquals(response.status, 200);
        const native = await response.json();
        const stats = native.statistics;
        assertEquals(summary.songs, stats.songCount);
        assertEquals(summary.artists, stats.browseArtistCount);
        assertEquals(summary.albums, stats.albumCount);
        assertEquals(summary.db_playtime, Math.trunc(stats.durationMs / 1000));
        assertEquals(native.tracks, undefined);
        if (count === 7) assertEquals(stats.artistCount, 5);
      }
      return summary;
    };
    const before = await compare(7, 4);
    const admin = (await f.login('cookie')).credential;
    const music = (await f.store.catalog.listLibraries()).find((l) =>
      l.name === 'Music'
    )!;
    const removed = await f.json(
      `/api/v1/admin/libraries/${music.id}`,
      'DELETE',
      undefined,
      admin,
    );
    assertEquals(removed.status, 204);
    const after = await compare(1, 1);
    assertEquals(after.updated_at, before.updated_at);
    assertEquals(after.albums, 1);
    assert(after.db_playtime < before.db_playtime);
    assertEquals(
      await f.own('/api/library/count?expression=DATA_KIND+IS+PIPE'),
      { tracks: 0, artists: 0, albums: 0, db_playtime: 0 },
    );
  } finally {
    await f.close();
  }
});

Deno.test('OwnTone core statistics: empty unscanned catalog keeps zero wire shapes and omits updated_at', async () => {
  const f = await coreBrowseFixture(true);
  try {
    assertEquals(await f.own('/api/library'), {
      songs: 0,
      db_playtime: 0,
      artists: 0,
      albums: 0,
      started_at: STARTED_AT,
      updating: false,
    });
    assertEquals(await f.own('/api/library/count'), {
      tracks: 0,
      artists: 0,
      albums: 0,
      db_playtime: 0,
    });
    assertEquals(await f.own('/api/library/files'), {
      directories: [],
      tracks: { items: [], total: 0, offset: 0, limit: -1 },
      playlists: { items: [], total: 0, offset: 0, limit: -1 },
    });
  } finally {
    await f.close();
  }
});

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
      (await get(
        app,
        '/api/search?type=tracks&expression=media_kind+is+music',
      ))
        .status,
      400,
    );
    assertEquals((await get(app, '/api/search?query=x')).status, 400);
    assertEquals((await get(app, '/api/search?type=tracks')).status, 400);
  } finally {
    await close();
  }
});

Deno.test('files: roots without directory, children by directory, no escape', async () => {
  const { app, close } = await setup();
  const fixture = await Deno.realPath('tests/fixtures/library');
  try {
    // No directory → the configured source roots.
    const roots = await (await get(app, '/api/library/files')).json();
    assertEquals(roots.directories, [{ path: fixture }]);
    assertEquals(roots.tracks.total, 0);
    assertEquals(roots.playlists.total, 0);

    // At a root: immediate subdirectories, no immediate tracks.
    const root = await (await get(
      app,
      `/api/library/files?directory=${encodeURIComponent(fixture)}`,
    )).json();
    assertEquals(root.directories, [
      { path: `${fixture}/Fixture Artist` },
      { path: `${fixture}/Various Artists` },
    ]);
    assertEquals(root.tracks.total, 0);

    // One level down: the album dir. Inside it: the media files.
    const artist = await (await get(
      app,
      `/api/library/files?directory=${
        encodeURIComponent(`${fixture}/Fixture Artist`)
      }`,
    )).json();
    assertEquals(artist.directories, [
      { path: `${fixture}/Fixture Artist/Fixture Album` },
    ]);
    const albumDir = await (await get(
      app,
      `/api/library/files?directory=${
        encodeURIComponent(
          `${fixture}/Fixture Artist/Fixture Album`,
        )
      }`,
    )).json();
    assertEquals(albumDir.directories, []);
    assertEquals(albumDir.tracks.total, 3);
    assertEquals(
      albumDir.tracks.items.map((t: { title: string }) => t.title).sort(),
      ['Clip', 'First Song', 'Second Song'],
    );

    // Outside every source root → 404 (no escape).
    assertEquals(
      (await get(app, '/api/library/files?directory=%2Fetc')).status,
      404,
    );
  } finally {
    await close();
  }
});

Deno.test('genre expression: tracks/albums/artists of a genre; other expressions 400', async () => {
  const { app, close } = await setup();
  try {
    const expr = encodeURIComponent('genre is "Fixture Rock"');
    const res = await get(
      app,
      `/api/search?type=tracks,albums,artists&expression=${expr}`,
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(
      body.tracks.items.map((t: { title: string }) => t.title).sort(),
      ['First Song', 'Second Song'],
    );
    assertEquals(
      body.albums.items.map((a: { name: string }) => a.name),
      ['Fixture Album'],
    );
    assertEquals(
      body.artists.items.map((a: { name: string }) => a.name),
      ['Fixture Artist'],
    );

    // The genre URI shape HA's get_genre uses per media type.
    const albumsOnly = await get(
      app,
      `/api/search?type=albums&expression=${expr}`,
    );
    const abody = await albumsOnly.json();
    assertEquals(abody.albums.total, 1);
    assertEquals(abody.tracks, undefined);

    // Still not the smart-playlist language.
    assertEquals(
      (await get(
        app,
        '/api/search?type=tracks&expression=genre+is+%22Pop%22+order+by+random',
      ))
        .status,
      400,
    );
  } finally {
    await close();
  }
});

Deno.test('artwork: item/group/nowplaying, artwork_url on payloads, listen isolation', async () => {
  const { app, onDefault, close } = await setup();
  try {
    // Payloads carry the relative urls.
    const albums = await (await get(app, '/api/library/albums')).json();
    const album = albums.items[0]; // Fixture Album (has cover.jpg)
    assertEquals(album.artwork_url, `./artwork/group/${album.id}`);

    const tracks = await (await get(
      app,
      `/api/library/albums/${album.id}/tracks`,
    )).json();
    const track = tracks.items[0];
    assertEquals(track.artwork_url, `./artwork/item/${track.id}`);

    const artists = await (await get(app, '/api/library/artists')).json();
    assertEquals(
      artists.items[0].artwork_url,
      `./artwork/group/${album.id}`, // first album's cover stands in
    );

    // item: the track's cover (its album's cover.jpg → image/jpeg).
    const item = await get(app, `/artwork/item/${track.id}`);
    assertEquals(item.status, 200);
    assertEquals(item.headers.get('content-type'), 'image/jpeg');
    await item.body?.cancel();

    // group: the album's cover.
    const group = await get(app, `/artwork/group/${album.id}`);
    assertEquals(group.status, 200);
    assertEquals(group.headers.get('content-type'), 'image/jpeg');
    await group.body?.cancel();

    // nowplaying: 404 on an empty queue; the queued track's cover after add.
    assertEquals((await get(app, '/artwork/nowplaying')).status, 404);
    const add = await app(
      new Request(
        `http://x/api/queue/items/add?uris=library:track:${track.id}`,
        {
          method: 'POST',
        },
      ),
    );
    assertEquals(add.status, 200);
    // Queued but stopped: still no current (no queue-head fallback).
    assertEquals((await get(app, '/artwork/nowplaying')).status, 404);
    assertEquals(
      (await app(new Request('http://x/api/player/play', { method: 'PUT' })))
        .status,
      204,
    );
    const np = await get(app, '/artwork/nowplaying');
    assertEquals(np.status, 200);
    assertEquals(np.headers.get('content-type'), 'image/jpeg');
    await np.body?.cancel();

    // Queue payloads inherit the track artwork_url.
    const queue = await (await get(app, '/api/queue')).json();
    assertEquals(queue.items[0].artwork_url, `./artwork/item/${track.id}`);

    // Unknown / malformed ids.
    assertEquals((await get(app, '/artwork/item/1')).status, 404);
    assertEquals((await get(app, '/artwork/item/abc')).status, 400);
    assertEquals((await get(app, '/artwork/group/1')).status, 404);

    // The artwork mount is the owntone hat's — not on the default listen.
    assertEquals((await get(onDefault, '/artwork/item/1')).status, 404);
    // …and the opensubsonic hat is still not on the hook.
    assertEquals((await get(app, '/rest/ping')).status, 404);
  } finally {
    await close();
  }
});
