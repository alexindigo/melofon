// A3: directory albums and placeholder artists through real scans and HTTP.
import { assert, assertEquals, assertMatch } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlaylists } from '../src/playlists.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { tagged } from './helpers/tagged.ts';

type Item = Record<string, unknown> & { id: string | number };
type Body = Record<string, unknown>;
function rows(container: unknown): Item[] {
  const value = (container as Body).items;
  assert(Array.isArray(value), 'items is an array');
  return value as Item[];
}
const ids = (items: { id: string | number }[]) =>
  items.map((item) => String(item.id)).sort();
// Independent protocol expectation; do not import the implementation's ids.
const wireId = (id: string) =>
  String(Number(BigInt(`0x${id.slice(0, 8)}`) & 0x7fffffffn));
async function placeholderWire(kind: 'various' | 'unknown') {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`melofon-placeholder-artist\n${kind}`),
  );
  return wireId(
    [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0'))
      .join('').slice(0, 32),
  );
}

async function setup(fn: (s: Setup) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-owntone-albums-' });
  const store = await openStore(`${dir}/db`);
  try {
    const libraries = createLibraries(store);
    const folders = [];
    for (const name of ['Music', 'Other']) {
      const root = `${dir}/${name}`;
      await Deno.mkdir(root);
      folders.push(await libraries.add(name, root));
    }
    // Same seven album cases and ten songs as A2, with genre tags to probe
    // OwnTone's genre-expression artist set as well as the browse roots.
    const files: [number, string, Record<string, string>][] = [
      [0, 'Tagged/a.mp3', {
        TALB: 'Tagged',
        TPE2: 'Various Artists',
        TPE1: 'Singer',
      }],
      [0, 'Singles/a.mp3', { TPE1: 'A', TDRC: '1990' }],
      [0, 'Singles/b.mp3', { TPE1: 'B', TDRC: '1990' }],
      [0, 'Tribute/a.mp3', { TALB: 'A Tribute', TPE1: 'C', TDRC: '2020' }],
      [0, 'Tribute/b.mp3', { TALB: 'A Tribute', TPE1: 'D', TDRC: '2020' }],
      [0, 'Solo/a.mp3', { TPE1: 'Solo Artist' }],
      [0, 'Mystery/a.mp3', {}],
      [0, 'Multi/CD1/a.mp3', {
        TALB: 'Multi',
        TPE2: 'Multi Artist',
        TPOS: '1/2',
      }],
      [0, 'Multi/CD2/b.mp3', {
        TALB: 'Multi',
        TPE2: 'Multi Artist',
        TPOS: '2/2',
      }],
      [1, 'Tagged/a.mp3', {
        TALB: 'Tagged',
        TPE2: 'Various Artists',
        TPE1: 'Singer',
      }],
    ];
    for (const [folder, rel, tags] of files) {
      const path = `${folders[folder].path}/${rel}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), {
        recursive: true,
      });
      await tagged(path, { TCON: 'Mixed', ...tags });
    }
    const scan = createScan(store);
    await scan.run();
    assertEquals((await scan.status()).count, 10);
    const cfg = {
      listen: undefined,
      dataDir: dir,
      user: 'admin',
      password: 'test',
      secret: 'test',
      version: 'test',
    };
    await seedFirstUser(store, cfg);
    const library = createLibrary(store);
    const playlists = createPlaylists(store);
    const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
    const app = facade(
      core,
      await loadLayers({
        app: {
          cfg,
          library,
          libraries,
          scan,
          playlists,
          playback: createPlayback({
            player: createPlayer(),
            nowPlaying: createNowPlaying(store),
            library,
            cfg,
          }),
        },
      }),
      { listenPort: 3689, defaultPort: 4534, env: {} },
    );
    const request = (path: string, method = 'GET') =>
      app(new Request(`http://x/api/${path}`, { method }));
    const get = async (path: string) => {
      const response = await request(path);
      assertEquals(response.status, 200, path);
      return await response.json() as Body;
    };
    await fn({ folders, library, libraries, scan, playlists, request, get });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

interface Setup {
  folders: { id: string; path: string }[];
  library: ReturnType<typeof createLibrary>;
  libraries: ReturnType<typeof createLibraries>;
  scan: ReturnType<typeof createScan>;
  playlists: ReturnType<typeof createPlaylists>;
  request(path: string, method?: string): Promise<Response>;
  get(path: string): Promise<Body>;
}

// Follow album links independently of the artist list, avoiding vacuous passes
// when placeholder artists are missing from a root under test.
async function placeholders(s: Setup): Promise<Item[]> {
  const artists = new Map<string, Item>();
  for (const album of rows(await s.get('library/albums'))) {
    if (String(album.artist).startsWith('[')) {
      const id = String(album.artist_id);
      artists.set(id, { id, name: album.artist });
    }
  }
  assertEquals(artists.size, 2);
  return [...artists.values()];
}

Deno.test('A3 every scanned song is reachable through artists, albums and tracks', async () => {
  await setup(async (s) => {
    const songs = new Set<string>();
    const albums = new Set<string>();
    for (const artist of rows(await s.get('library/artists'))) {
      for (
        const album of rows(await s.get(`library/artists/${artist.id}/albums`))
      ) {
        albums.add(String(album.id));
        assertEquals(album.artist_id, artist.id);
        for (
          const song of rows(await s.get(`library/albums/${album.id}/tracks`))
        ) {
          songs.add(String(song.id));
          assertEquals(song.album_id, album.id);
          assertEquals(song.album_artist_id, artist.id);
        }
      }
    }
    const scanned = await s.library.listSongs({ offset: 0, size: 500 });
    assertEquals(scanned.length, 10);
    assertEquals(
      [...songs].sort(),
      scanned.map((song) => wireId(song.id)).sort(),
    );
    assertEquals([...albums].sort(), ids(rows(await s.get('library/albums'))));
  });
});

Deno.test('A3 album labels distinguish real Various Artists and merge evidenced discs', async () => {
  await setup(async (s) => {
    const albums = rows(await s.get('library/albums'));
    assertEquals(
      albums.map((a) => [a.name, a.artist]).sort(),
      [
        ['A Tribute', '[Various Artists]'],
        ['Multi', 'Multi Artist'],
        ['Tagged', 'Various Artists'],
        ['Tagged', 'Various Artists'],
        ['[Mystery]', '[Unknown Artist]'],
        ['[Singles]', '[Various Artists]'],
        ['[Solo]', 'Solo Artist'],
      ].sort(),
    );
    assertEquals(albums.filter((a) => a.name === 'Multi').length, 1);
    const multi = albums.find((a) => a.name === 'Multi')!;
    assertEquals(
      rows(await s.get(`library/albums/${multi.id}/tracks`)).length,
      2,
    );
    for (const album of albums) {
      assertEquals(await s.get(`library/albums/${album.id}`), album);
    }
  });
});

Deno.test('A3 placeholder ids, artist payloads, membership and paging agree', async () => {
  await setup(async (s) => {
    const all = rows(await s.get('library/artists'));
    assertEquals(all.length, 5);
    for (const artist of await placeholders(s)) {
      const kind = artist.name === '[Various Artists]' ? 'various' : 'unknown';
      assertMatch(String(artist.id), /^\d+$/);
      assertEquals(artist.id, await placeholderWire(kind));
      const detail = await s.get(`library/artists/${artist.id}`);
      assertEquals(detail, all.find((a) => a.id === artist.id));
      const albums = rows(await s.get(`library/artists/${artist.id}/albums`));
      assertEquals(
        albums.map((a) => a.name),
        kind === 'various' ? ['A Tribute', '[Singles]'] : ['[Mystery]'],
      );
      assertEquals(detail.album_count, albums.length);
      assertEquals(detail.track_count, kind === 'various' ? 4 : 1);
      assertEquals(
        detail.length_ms,
        albums.reduce((n, a) => n + Number(a.length_ms), 0),
      );
      assertEquals(detail.artwork_url, `./artwork/group/${albums[0].id}`);
      assertEquals(detail.uri, `library:artist:${artist.id}`);
    }
    const real = all.find((a) => a.name === 'Various Artists')!;
    assertEquals(real.album_count, 2);
    assertEquals(
      rows(await s.get(`library/artists/${real.id}/albums`)).length,
      2,
    );
    const page = await s.get('library/artists?offset=1&limit=2');
    assertEquals(page.total, all.length);
    assertEquals(rows(page), all.slice(1, 3));
    const various = await placeholderWire('various');
    const albumPage = await s.get(
      `library/artists/${various}/albums?offset=1&limit=1`,
    );
    assertEquals(albumPage.total, 2);
    assertEquals(rows(albumPage).map((a) => a.name), ['[Singles]']);
  });
});

Deno.test('A3 both artist statistics equal the full artist root length', async () => {
  await setup(async (s) => {
    const artists = await s.get('library/artists');
    assertEquals(artists.total, 5);
    assertEquals(rows(artists).length, artists.total);
    for (const path of ['library', 'library/count']) {
      const stats = await s.get(path);
      assertEquals(stats.artists, artists.total);
      assertEquals(stats.albums, 7);
      assertEquals(stats[path === 'library' ? 'songs' : 'tracks'], 10);
    }
  });
});

function checkTrack(song: Body, album: Item) {
  for (
    const key of [
      'album',
      'album_sort',
      'artist',
      'artist_sort',
      'album_artist',
      'album_artist_sort',
    ]
  ) {
    assert(typeof song[key] === 'string' && String(song[key]).length > 0, key);
  }
  assertEquals(song.album, album.name);
  assertEquals(song.album_id, album.id);
  assertEquals(song.album_artist, album.artist);
  assertEquals(song.album_artist_id, album.artist_id);
}

Deno.test('A3 nonempty album and artist labels reach track, search, files and playlist payloads', async () => {
  await setup(async (s) => {
    const albums = rows(await s.get('library/albums'));
    const scanned = await s.library.listSongs({ offset: 0, size: 500 });
    const playlist = await s.playlists.create(
      'admin',
      'All',
      scanned.map((song) => song.id),
    );
    const playlistTracks = rows(
      await s.get(`library/playlists/${wireId(playlist.id)}/tracks`),
    );
    for (const album of albums) {
      for (const key of ['name', 'name_sort', 'artist']) {
        assert(typeof album[key] === 'string' && String(album[key]).length > 0);
      }
      const tracks = rows(await s.get(`library/albums/${album.id}/tracks`));
      for (const song of tracks) {
        checkTrack(song, album);
        checkTrack(await s.get(`library/tracks/${song.id}`), album);
        checkTrack(playlistTracks.find((t) => t.id === song.id)!, album);
        const directory = String(song.path).slice(
          0,
          String(song.path).lastIndexOf('/'),
        );
        const files = await s.get(
          `library/files?directory=${encodeURIComponent(directory)}`,
        );
        checkTrack(rows(files.tracks).find((t) => t.id === song.id)!, album);
      }
    }
    const searched = await s.get('search?type=tracks,albums&query=');
    assertEquals(rows(searched.tracks).length, 10);
    assertEquals(ids(rows(searched.albums)), ids(albums));
    for (const song of rows(searched.tracks)) {
      checkTrack(song, albums.find((a) => a.id === song.album_id)!);
    }
  });
});

Deno.test('A3 placeholder artist URIs expand into their songs and retain labels in queue views', async () => {
  await setup(async (s) => {
    const albums = rows(await s.get('library/albums'));
    for (const artist of await placeholders(s)) {
      const response = await s.request(
        `queue/items/add?uris=library:artist:${artist.id}&clear=true`,
        'POST',
      );
      assertEquals(response.status, 200);
      const added = await response.json();
      const expected = albums.filter((a) => a.artist_id === artist.id);
      const trackIds = [];
      for (const album of expected) {
        trackIds.push(
          ...rows(await s.get(`library/albums/${album.id}/tracks`)),
        );
      }
      assertEquals(added.count, trackIds.length);
      const queue = await s.get('queue');
      for (const body of [added, queue]) {
        const items = rows(body);
        assertEquals(
          items.map((t) => String(t.track_id)).sort(),
          ids(trackIds),
        );
        for (const item of items) {
          checkTrack(item, expected.find((a) => a.id === item.album_id)!);
        }
      }
    }
  });
});

Deno.test('A3 genre artist results include placeholders with matching album artist links', async () => {
  await setup(async (s) => {
    const expression = encodeURIComponent('genre is "Mixed"');
    const result = await s.get(
      `search?type=artists,albums,tracks&expression=${expression}`,
    );
    const artists = rows(result.artists);
    assertEquals(ids(artists), ids(rows(await s.get('library/artists'))));
    assertEquals(artists.length, 5);
    const albums = rows(result.albums);
    assertEquals(albums.length, 7);
    for (const album of albums) {
      assert(
        artists.some((a) =>
          a.id === album.artist_id && a.name === album.artist
        ),
      );
    }
    for (const track of rows(result.tracks)) {
      checkTrack(track, albums.find((a) => a.id === track.album_id)!);
    }
    const page = await s.get(
      `search?type=artists&expression=${expression}&offset=1&limit=2`,
    );
    assertEquals((page.artists as Body).total, artists.length);
    assertEquals(rows(page.artists), artists.slice(1, 3));
    const missing = await s.get(
      `search?type=artists&expression=${
        encodeURIComponent('genre is "Absent"')
      }`,
    );
    assertEquals(rows(missing.artists), []);
  });
});

Deno.test('A3 placeholders disappear when no albums remain and return after rescan', async () => {
  await setup(async (s) => {
    await s.libraries.remove(s.folders[0].id);
    await s.scan.run();
    const all = rows(await s.get('library/artists'));
    assertEquals(all.map((a) => a.name), ['Various Artists']);
    for (const kind of ['various', 'unknown'] as const) {
      const id = await placeholderWire(kind);
      assertEquals((await s.request(`library/artists/${id}`)).status, 404);
      assertEquals(
        (await s.request(`library/artists/${id}/albums`)).status,
        404,
      );
      assertEquals(
        (await s.request(`queue/items/add?uris=library:artist:${id}`, 'POST'))
          .status,
        404,
      );
    }
    for (const path of ['library', 'library/count']) {
      assertEquals((await s.get(path)).artists, all.length);
    }
    await s.libraries.add('Music', s.folders[0].path);
    await s.scan.run();
    assertEquals(rows(await s.get('library/artists')).length, 5);
    for (const kind of ['various', 'unknown'] as const) {
      assertEquals(
        (await s.get(`library/artists/${await placeholderWire(kind)}`)).id,
        await placeholderWire(kind),
      );
    }
  });
});
