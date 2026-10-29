import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';

const base = '/api/v1/search';
const categories = ['artists', 'albums', 'songs'] as const;
type Category = typeof categories[number];
type Row = {
  id: string;
  name?: string | null;
  title?: string | null;
  folderName?: string;
  fileName?: string;
};
const identity = (rows: Row[]) => rows.map((r) => r.id);
const text = (row: Row, category: Category) =>
  category === 'songs'
    ? row.title ?? row.fileName!
    : row.name ?? row.folderName!;
const folded = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
function expected(rows: Row[], category: Category, query = '') {
  return rows.filter((r) =>
    text(r, category).toLowerCase().includes(query.toLowerCase())
  )
    .sort((a, b) => {
      const left = folded(text(a, category));
      const right = folded(text(b, category));
      return left < right
        ? -1
        : left > right
        ? 1
        : a.id < b.id
        ? -1
        : a.id > b.id
        ? 1
        : 0;
    });
}

async function searchFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-search-' });
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        for (const name of ['Music', 'Second', 'Empty']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        const records = [
          ['Music/0', 'Same Match', 'Same Match', 'élan Match', 'élan Match'],
          ['Music/1', 'Same Match', 'Same Match', 'ELAN Match', 'ELAN Match'],
          [
            'Music/2',
            'alpha Match',
            'alpha Match',
            'alpha Match',
            'alpha Match',
          ],
          ['Music/3', 'The Match', 'The Match', 'The Match', 'The Match'],
          ['Second/0', 'Same Match', 'Same Match', 'élan Match', 'élan Match'],
          ['Second/1', 'Other', 'Other', 'Track only Match', 'Collection'],
          ['Music/Mix', 'Guest One', 'Mix', 'Guest Match', ''],
          ['Music/Mix', 'Guest Two', 'Mix', 'Another Guest', ''],
        ];
        for (
          const [i, [dir, title, album, artist, albumArtist]] of records
            .entries()
        ) {
          await Deno.mkdir(`${root}/${dir}`, { recursive: true });
          await tagged(`${root}/${dir}/${i}.mp3`, {
            TIT2: title,
            TALB: album,
            TPE1: artist,
            ...(albumArtist ? { TPE2: albumArtist } : {}),
          });
        }
        await Deno.mkdir(`${root}/Music/Loose_Match`);
        await tagged(`${root}/Music/Loose_Match/no_title_match.mp3`, {});
        await scanLibrary(f.store);
        return { libraries, library: createLibrary(f.store) };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    const albums = await f.store.catalog.listAlbums({
      sort: 'name',
      offset: 0,
      size: 100,
    });
    const artists = await f.store.catalog.listArtists();
    const libraries = await f.store.catalog.listLibraries();
    return {
      ...f,
      root,
      songs,
      albums,
      artists,
      libraries,
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

async function error(response: Response, status: number, code: string) {
  assertEquals(response.status, status);
  const body = await response.json();
  assertEquals(body.code, code);
  assertEquals(Object.keys(body).sort(), ['code', 'message']);
}

Deno.test('API search: independent bounded category pages have exact totals, folded name/ID ties and shared native DTOs', async () => {
  const f = await searchFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const read = async (query = '') => {
        const r = await f.get(base + query, credential, {
          Origin: 'http://foreign.home',
        });
        assertEquals(r.status, 200, await r.clone().text());
        return await r.json();
      };
      const full = await read('?query=match');
      assertEquals(Object.keys(full).sort(), ['albums', 'artists', 'songs']);
      assertEquals(categories.map((c) => full[c].total), [4, 6, 6]);
      for (const category of categories) {
        const wanted = expected(f[category], category, 'match');
        assertEquals(identity(full[category][category]), identity(wanted));
        assertEquals([full[category].offset, full[category].limit], [0, 50]);
        const joined: Row[] = [];
        const prefix = category.slice(0, -1);
        for (let offset = 0; offset <= wanted.length + 1; offset++) {
          const page = await read(
            `?query=match&${prefix}Offset=${offset}&${prefix}Limit=1`,
          );
          assertEquals(page[category].total, wanted.length);
          assertEquals([page[category].offset, page[category].limit], [
            offset,
            1,
          ]);
          assertEquals(
            page[category][category],
            full[category][category].slice(offset, offset + 1),
          );
          joined.push(...page[category][category]);
          for (const other of categories.filter((c) => c !== category)) {
            assertEquals(page[other], full[other]);
          }
        }
        assertEquals(joined, full[category][category]);
        for (const row of full[category][category]) {
          const detail = await f.get(
            `/api/v1/${category}/${row.id}`,
            credential,
          );
          assertEquals(detail.status, 200);
          const opened = (await detail.json())[prefix];
          if (category === 'albums') delete opened.songs;
          assertEquals(row, opened);
          for (
            const key of [
              'starred',
              'userRating',
              'averageRating',
              'playCount',
              'played',
              'lastPlayed',
              'libraryPath',
            ]
          ) assert(!(key in row));
        }
      }
      const nullSong = full.songs.songs.find((s: Row) => s.title === null);
      assertEquals(nullSong.label, '[no title match]');
      assertEquals(nullSong.path, 'Loose_Match/no_title_match.mp3');
      const nullAlbum = full.albums.albums.find((a: Row) => a.name === null);
      assertEquals(nullAlbum.label, '[Loose_Match]');
      const admin = (await f.login('bearer')).credential;
      assertEquals(
        await (await f.get(base + '?query=match', admin)).json(),
        full,
      );
    }
    assert(f.origin.startsWith('http://melofon.home:'));
    assert(f.peers.every((p) => p !== '127.0.0.1' && p !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API search: matching, empty query, absent matches and library-scoped counts preserve the existing search contract', async () => {
  const f = await searchFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const library of [undefined, ...f.libraries]) {
        const scope = library ? `&library=${library.id}` : '';
        for (
          const query of [
            '',
            'match',
            'Guest',
            'élan',
            'unknown',
            "' OR 1=1 --",
            'nothing-found',
            '%',
          ]
        ) {
          const response = await f.get(
            `${base}?query=${encodeURIComponent(query)}${scope}`,
            credential,
          );
          assertEquals(response.status, 200);
          const pages = await response.json();
          const legacy = await f.store.catalog.search3(query, {
            folderId: library?.id,
            ignoredArticles: [],
            artistCount: 100,
            artistOffset: 0,
            albumCount: 100,
            albumOffset: 0,
            songCount: 100,
            songOffset: 0,
          });
          for (const c of categories) {
            assertEquals(pages[c].total, legacy[c].length);
            assertEquals(identity(pages[c][c]), identity(legacy[c]));
          }
          if (library?.name === 'Second' && query === 'match') {
            assertEquals(categories.map((c) => pages[c].total), [1, 1, 1]);
            assertEquals(pages.artists.artists[0].albumCount, 1);
          }
          if (!library && query === '') {
            assertEquals(categories.map((c) => pages[c].total), [5, 8, 9]);
          }
          if (!library && query === 'Guest') {
            assertEquals(categories.map((c) => pages[c].total), [0, 0, 2]);
          }
        }
      }
      const implicit = await (await f.get(base, credential)).json();
      assertEquals(
        implicit,
        await (await f.get(base + '?query=', credential)).json(),
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('API search: validators cover query, scope and each category page and change after catalog publication', async () => {
  const f = await searchFixture();
  try {
    const music = f.libraries.find((l) => l.name === 'Music')!;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const tags = new Set();
      for (
        const query of [
          '',
          '?query=match',
          '?artistOffset=1',
          '?artistLimit=1',
          '?albumOffset=1',
          '?albumLimit=1',
          '?songOffset=1',
          '?songLimit=1',
          `?library=${music.id}`,
        ]
      ) {
        const response = await f.get(base + query, credential);
        assertEquals(response.status, 200);
        const etag = response.headers.get('etag')!;
        assert(etag.startsWith('W/"'));
        assertEquals(
          response.headers.get('cache-control'),
          'private, no-cache',
        );
        tags.add(etag);
        await response.json();
        const cached = await f.get(base + query, credential, {
          'If-None-Match': etag,
        });
        assertEquals(cached.status, 304);
        assertEquals(await cached.text(), '');
        assertEquals(cached.headers.get('etag'), etag);
        assertEquals(cached.headers.get('cache-control'), 'private, no-cache');
      }
      assertEquals(tags.size, 9);
      const first = await f.get(base, credential);
      const etag = first.headers.get('etag')!;
      await first.json();
      const canonical = await f.get(
        base +
          '?query=&artistOffset=00&artistLimit=050&albumOffset=0&albumLimit=50&songOffset=0&songLimit=50',
        credential,
        { 'If-None-Match': etag },
      );
      assertEquals(canonical.status, 304);
      await canonical.text();
      await error(
        await f.get(base, undefined, { 'If-None-Match': etag }),
        401,
        'unauthenticated',
      );
    }
    const { credential } = await f.login(
      'bearer',
      'listener',
      'password-listener',
    );
    const before = await f.get(base + '?query=match', credential);
    const etag = before.headers.get('etag')!;
    await before.json();
    await tagged(`${f.root}/Music/2/2.mp3`, {
      TIT2: 'Changed',
      TALB: 'Changed',
      TPE1: 'Changed',
      TPE2: 'Changed',
    });
    await scanLibrary(f.store);
    const after = await f.get(base + '?query=match', credential, {
      'If-None-Match': etag,
    });
    assertEquals(after.status, 200);
    assertNotEquals(after.headers.get('etag'), etag);
    const pages = await after.json();
    assertEquals(categories.map((c) => pages[c].total), [3, 5, 5]);
  } finally {
    await f.close();
  }
});

Deno.test('API search: strict per-category paging, library validation, authentication and live shared limits', async () => {
  const f = await searchFixture();
  try {
    await error(await f.get(base), 401, 'unauthenticated');
    const { credential } = await f.login(
      'cookie',
      'listener',
      'password-listener',
    );
    await error(
      await f.get(base, credential, {
        Authorization: 'Bearer invalid',
        'If-None-Match': '*',
      }),
      401,
      'unauthenticated',
    );
    for (
      const query of [
        '?unknown=1',
        '?query=a&query=b',
        '?library=a&library=b',
        '?library=',
        '?offset=1',
        '?limit=1',
        '?sort=name',
        '?artistLimit=0',
        '?albumLimit=501',
        '?songLimit=',
        '?songLimit=1e2',
        '?artistOffset=-1',
        '?albumOffset=1.1',
        '?songOffset=9007199254740992',
        '?songOffset=1&songOffset=2',
        '?albumLimit=1&albumLimit=2',
      ]
    ) {
      await error(
        await f.get(base + query, credential, { 'If-None-Match': '*' }),
        400,
        'invalid_field',
      );
    }
    await error(
      await f.get(base + '?library=missing', credential, {
        'If-None-Match': '*',
      }),
      404,
      'not_found',
    );
    const method = await f.json(base, 'POST', {}, credential);
    await error(method, 405, 'method_not_allowed');
    assertEquals(method.headers.get('allow'), 'GET');
    await f.state.set('melofon.browseMaxPageRecords', '2');
    await f.state.set('melofon.browsePageRecords', '3');
    const page = await (await f.get(base, credential)).json();
    for (const c of categories) {
      assertEquals([page[c].limit, page[c][c].length], [2, 2]);
    }
    await error(
      await f.get(base + '?songLimit=3', credential),
      400,
      'invalid_field',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API search: an empty catalog retains exact out-of-range envelopes for every category', async () => {
  const f = await apiFixture({
    services: (f) => Promise.resolve({ library: createLibrary(f.store) }),
  });
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(use);
      const response = await f.get(
        base +
          '?query=&artistOffset=8&albumOffset=9&songOffset=10&artistLimit=1&albumLimit=2&songLimit=3',
        credential,
      );
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        artists: { artists: [], total: 0, offset: 8, limit: 1 },
        albums: { albums: [], total: 0, offset: 9, limit: 2 },
        songs: { songs: [], total: 0, offset: 10, limit: 3 },
      });
    }
  } finally {
    await f.close();
  }
});
