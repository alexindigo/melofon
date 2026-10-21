// A2: directory albums and placeholder artists through real scans and HTTP.
import { assert, assertEquals, assertMatch } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { BlobReader, Uint8ArrayWriter, ZipReader } from '@zip-js/zip-js';
import { openStore } from '../src/store/index.ts';
import { seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { createScan } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { createUserService } from '../src/user.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createArtwork } from '../src/artwork.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createZip } from '../src/zip.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';
import { createReference } from '../src/reference.ts';
import { tagged } from './helpers/tagged.ts';

type Item = Record<string, unknown> & { id: string; name: string };
function rows(container: unknown, key: string): Item[] {
  const value = (container as Record<string, unknown>)[key];
  assert(Array.isArray(value), `${key} is an array`);
  return value as Item[];
}
const ids = (items: { id: string }[]) => items.map((a) => a.id).sort();

async function setup(fn: (s: Setup) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-subsonic-albums-' });
  const store = await openStore(`${dir}/db`);
  try {
    const libraries = createLibraries(store);
    const folders = [];
    for (const name of ['Music', 'Other']) {
      const root = `${dir}/${name}`;
      await Deno.mkdir(root);
      folders.push(await libraries.add(name, root));
    }
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
      await tagged(path, tags);
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
    const state = createState(store);
    const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
    const app = facade(
      core,
      await loadLayers({
        app: {
          state,
          reference: createReference({
            store,
            state,
            providers: () => Promise.resolve([]),
            enqueue: () => Promise.resolve(),
          }),
          cfg,
          library,
          libraries,
          scan,
          user: createUserService(store, cfg),
          annotation: createAnnotation(store),
          listens: createListens(store),
          artwork: createArtwork(library),
          playlists: createPlaylists(store),
          zip: createZip(),
        },
      }),
    );
    const request = async (op: string, extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({
        u: 'admin',
        p: 'test',
        v: '1.16.1',
        c: 'album-test',
        f: 'json',
        ...extra,
      });
      return await app(new Request(`http://x/rest/${op}?${params}`));
    };
    const get = async (op: string, extra: Record<string, string> = {}) => {
      const response = await request(op, extra);
      assertEquals(response.status, 200);
      const body = (await response.json())['subsonic-response'];
      assertEquals(body.status, 'ok', `${op}: ${JSON.stringify(body.error)}`);
      return body as Record<string, unknown>;
    };
    const index = async (legacy = false, musicFolderId?: string) => {
      const body = await get(
        legacy ? 'getIndexes' : 'getArtists',
        musicFolderId === undefined ? {} : { musicFolderId },
      );
      return rows(body[legacy ? 'indexes' : 'artists'], 'index')
        .flatMap((group) => rows(group, 'artist'));
    };
    const albums = async (musicFolderId?: string) =>
      rows(
        (await get('getAlbumList2', {
          type: 'alphabeticalByName',
          size: '500',
          ...(musicFolderId === undefined ? {} : { musicFolderId }),
        })).albumList2,
        'album',
      );
    await fn({ folders, library, get, request, index, albums });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

interface Setup {
  folders: { id: string; path: string }[];
  library: ReturnType<typeof createLibrary>;
  get(
    op: string,
    extra?: Record<string, string>,
  ): Promise<Record<string, unknown>>;
  request(op: string, extra?: Record<string, string>): Promise<Response>;
  index(legacy?: boolean, folderId?: string): Promise<Item[]>;
  albums(folderId?: string): Promise<Item[]>;
}

// Follow album links independently of the roots being tested, so sibling
// endpoint tests cannot pass vacuously when placeholders are absent there.
async function placeholders(s: Setup): Promise<Item[]> {
  const artists = new Map<string, Item>();
  for (const album of await s.albums()) {
    if (String(album.artist).startsWith('[')) {
      const id = String(album.artistId);
      artists.set(id, { id, name: String(album.artist) });
    }
  }
  assertEquals(artists.size, 2);
  return [...artists.values()];
}

for (const legacy of [false, true]) {
  Deno.test(`A2 every scanned song is reachable through ${legacy ? 'folder' : 'ID3'} browse`, async () => {
    await setup(async (s) => {
      const songs = new Set<string>();
      const albums = new Set<string>();
      for (const artist of await s.index(legacy)) {
        const body = await s.get(legacy ? 'getMusicDirectory' : 'getArtist', {
          id: artist.id,
        });
        for (
          const album of rows(
            body[legacy ? 'directory' : 'artist'],
            legacy ? 'child' : 'album',
          )
        ) {
          albums.add(album.id);
          const opened = await s.get(
            legacy ? 'getMusicDirectory' : 'getAlbum',
            {
              id: album.id,
            },
          );
          for (
            const song of rows(
              opened[legacy ? 'directory' : 'album'],
              legacy ? 'child' : 'song',
            )
          ) {
            songs.add(song.id);
            assertEquals(song.parent, album.id);
          }
        }
      }
      const scanned = await s.library.listSongs({ offset: 0, size: 500 });
      assertEquals(scanned.length, 10);
      assertEquals([...songs].sort(), ids(scanned));
      assertEquals([...albums].sort(), ids(await s.albums()));
    });
  });
}

Deno.test('A2 album labels and disc evidence survive both browse shapes', async () => {
  await setup(async (s) => {
    const albums = await s.albums(s.folders[0].id);
    assertEquals(
      albums.map((a) => [a.name, a.artist]).sort(),
      [
        ['A Tribute', '[Various Artists]'],
        ['Multi', 'Multi Artist'],
        ['Tagged', 'Various Artists'],
        ['[Mystery]', '[Unknown Artist]'],
        ['[Singles]', '[Various Artists]'],
        ['[Solo]', 'Solo Artist'],
      ].sort(),
    );
    const multi = albums.filter((a) => a.name === 'Multi');
    assertEquals(multi.length, 1);
    const opened = (await s.get('getAlbum', { id: multi[0].id })).album;
    assertEquals(rows(opened, 'song').length, 2);
    for (const album of albums) {
      const directory = (await s.get('getMusicDirectory', { id: album.id }))
        .directory as Item;
      assertEquals([directory.name, directory.parent], [
        album.name,
        album.artistId,
      ]);
      assertEquals(
        rows(directory, 'child').map((song) => song.album),
        Array(album.songCount).fill(album.name),
      );
    }
  });
});

Deno.test('A2 every folder album total equals the unfiltered opened album', async () => {
  await setup(async (s) => {
    const all = new Set<string>();
    for (const folder of s.folders) {
      const albums = await s.albums(folder.id);
      assertEquals(albums.length, folder === s.folders[0] ? 6 : 1);
      for (const album of albums) {
        assert(!all.has(album.id), 'an album belongs to just one music folder');
        all.add(album.id);
        const opened = (await s.get('getAlbum', { id: album.id }))
          .album as Item;
        assertEquals([album.songCount, album.duration], [
          opened.songCount,
          opened.duration,
        ]);
        assertEquals(opened.songCount, rows(opened, 'song').length);
      }
    }
    assertEquals([...all].sort(), ids(await s.albums()));
  });
});

Deno.test('A2 placeholder roots are folder-aware with accurate counts and stable ids', async () => {
  await setup(async (s) => {
    const placeholders = (await s.index()).filter((a) =>
      a.name.startsWith('[')
    );
    assertEquals(placeholders.map((a) => [a.name, a.albumCount]), [
      ['[Unknown Artist]', 1],
      ['[Various Artists]', 2],
    ]);
    for (const artist of placeholders) {
      const kind = artist.name === '[Various Artists]' ? 'various' : 'unknown';
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`melofon-placeholder-artist\n${kind}`),
      );
      const expected = [...new Uint8Array(digest)].map((b) =>
        b.toString(16).padStart(2, '0')
      ).join('').slice(0, 32);
      assertMatch(artist.id, /^[a-f0-9]{32}$/);
      assertEquals(artist.id, expected);
    }
    for (const legacy of [false, true]) {
      const first = await s.index(legacy, s.folders[0].id);
      assertEquals(
        ids(first.filter((a) => a.name.startsWith('['))),
        ids(placeholders),
      );
      if (!legacy) {
        assertEquals(
          first.filter((a) => a.name.startsWith('[')).map((a) => a.albumCount),
          [1, 2],
        );
      }
      const second = await s.index(legacy, s.folders[1].id);
      assertEquals(second.map((a) => a.name), ['Various Artists']);
      // A real artist spans folders; inside one folder its album count covers
      // only that folder's albums (Navidrome), unfiltered it covers all.
      assertEquals(second[0].albumCount, legacy ? undefined : 1);
      assertEquals(
        (await s.index(legacy)).find((a) => a.name === 'Various Artists')
          ?.albumCount,
        legacy ? undefined : 2,
      );
    }
    const groups = rows((await s.get('getArtists')).artists, 'index');
    assertEquals(
      rows(groups.find((g) => g.name === '[Unknown]'), 'artist').map((a) =>
        a.name
      ),
      ['[Unknown Artist]', '[Various Artists]'],
    );
  });
});

Deno.test('A2 placeholder artist albums use each existing endpoint order', async () => {
  await setup(async (s) => {
    const artist = (await placeholders(s)).find((a) =>
      a.name === '[Various Artists]'
    )!;
    const opened = (await s.get('getArtist', { id: artist.id })).artist as Item;
    assertEquals([opened.name, opened.albumCount], ['[Various Artists]', 2]);
    assertEquals(rows(opened, 'album').map((a) => a.name), [
      '[Singles]',
      'A Tribute',
    ]);
    const directory = (await s.get('getMusicDirectory', { id: artist.id }))
      .directory as Item;
    assertEquals(directory.name, artist.name);
    assertEquals(rows(directory, 'child').map((a) => a.name), [
      'A Tribute',
      '[Singles]',
    ]);
    for (const album of rows(directory, 'child')) {
      assertEquals(album.parent, artist.id);
    }
  });
});

Deno.test('A2 wire album names and artists and song album labels are never null or empty', async () => {
  await setup(async (s) => {
    for (const album of await s.albums()) {
      const opened = (await s.get('getAlbum', { id: album.id })).album as Item;
      for (const row of [album, opened]) {
        assert(typeof row.name === 'string' && row.name.length > 0);
        assert(typeof row.artist === 'string' && row.artist.length > 0);
      }
      for (const song of rows(opened, 'song')) {
        const single = (await s.get('getSong', { id: song.id })).song as Item;
        for (const row of [song, single]) {
          assert(typeof row.album === 'string' && row.album.length > 0);
          assertEquals(row.album, album.name);
        }
      }
    }
  });
});

Deno.test('A2 placeholder artist info and artwork match an artist without external data', async () => {
  await setup(async (s) => {
    const artists = await s.index();
    const real = artists.find((a) => a.name === 'Various Artists')!;
    for (const artist of await placeholders(s)) {
      for (const op of ['getArtistInfo', 'getArtistInfo2']) {
        const key = op === 'getArtistInfo' ? 'artistInfo' : 'artistInfo2';
        assertEquals((await s.get(op, { id: artist.id }))[key], {});
        assertEquals((await s.get(op, { id: real.id }))[key], {});
      }
      const image = await s.request('getCoverArt', { id: artist.id });
      const reference = await s.request('getCoverArt', { id: real.id });
      assertEquals(image.status, 200);
      assertEquals(image.headers.get('content-type'), 'image/png');
      assertEquals(
        new Uint8Array(await image.arrayBuffer()),
        new Uint8Array(await reference.arrayBuffer()),
      );
      const opened = (await s.get('getArtist', { id: artist.id }))
        .artist as Item;
      assertEquals(opened.coverArt, real.coverArt);
    }
  });
});

Deno.test('A2 placeholder artist download contains its albums and original file bytes', async () => {
  await setup(async (s) => {
    const songs = await s.library.listSongs({ offset: 0, size: 500 });
    for (const artist of await placeholders(s)) {
      const response = await s.request('download', { id: artist.id });
      assertEquals(response.headers.get('content-type'), 'application/zip');
      assertEquals(
        response.headers.get('content-disposition'),
        `attachment; filename="${artist.name}.zip"`,
      );
      const reader = new ZipReader(new BlobReader(await response.blob()));
      try {
        const entries = (await reader.getEntries()).filter((e) => !e.directory);
        const expected = artist.name === '[Various Artists]'
          ? ['Singles/a.mp3', 'Singles/b.mp3', 'Tribute/a.mp3', 'Tribute/b.mp3']
          : ['Mystery/a.mp3'];
        assertEquals(entries.map((e) => e.filename).sort(), expected);
        for (const entry of entries) {
          const song = songs.find((s) =>
            s.path === `${s.libraryPath}/${entry.filename}`
          )!;
          assert(song);
          assertEquals(
            await entry.getData(new Uint8ArrayWriter()),
            await Deno.readFile(song.path),
          );
        }
      } finally {
        await reader.close();
      }
    }
  });
});

Deno.test('A2 placeholders remain absent from search and cannot be starred or rated', async () => {
  await setup(async (s) => {
    for (const artist of await placeholders(s)) {
      // Unknown star ids are successful no-ops; unknown rating ids return 70.
      await s.get('star', { artistId: artist.id });
      assertEquals(rows((await s.get('getStarred2')).starred2, 'artist'), []);
      const body =
        (await (await s.request('setRating', { id: artist.id, rating: '5' }))
          .json())['subsonic-response'];
      assertEquals([body.status, body.error.code], ['failed', 70]);
      const opened = (await s.get('getArtist', { id: artist.id }))
        .artist as Item;
      assertEquals([opened.starred, opened.userRating], [undefined, undefined]);
      for (
        const [op, key] of [['search2', 'searchResult2'], [
          'search3',
          'searchResult3',
        ]]
      ) {
        const found = rows(
          (await s.get(op, { query: artist.name }))[key],
          'artist',
        );
        assert(!found.some((a) => a.id === artist.id));
      }
    }
  });
});

Deno.test('folder-scoped artist album counts in search3 follow the folder', async () => {
  await setup(async (s) => {
    const count = async (musicFolderId?: string) => {
      const body = await s.get('search3', {
        query: 'Various',
        ...(musicFolderId === undefined ? {} : { musicFolderId }),
      });
      const artist = rows(body.searchResult3, 'artist').find((a) =>
        a.name === 'Various Artists'
      );
      return artist?.albumCount;
    };
    assertEquals(await count(), 2);
    assertEquals(await count(s.folders[0].id), 1);
    assertEquals(await count(s.folders[1].id), 1);
  });
});
