import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';
import type { AlbumRow } from '../src/library.ts';

const base = '/api/v1/albums';

async function albumFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-albums-' });
  let albums: AlbumRow[] = [];
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        for (const name of ['Music', 'Second', 'Empty']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        const tracks: [string, Record<string, string>][] = [
          ['Music/Multi/CD1/z.mp3', {
            TALB: 'Same',
            TPE2: 'Beta',
            TPE1: 'Beta',
            TPOS: '1',
            TRCK: '1',
            TDRC: '2000',
            TCON: 'Jazz',
          }],
          ['Music/Multi/CD1/a.mp3', {
            TALB: 'Same',
            TPE2: 'Beta',
            TPE1: 'Beta',
            TPOS: '1',
            TRCK: '2',
            TDRC: '2024',
            TCON: 'Rock',
          }],
          ['Music/Multi/CD2/b.mp3', {
            TALB: 'Same',
            TPE2: 'Beta',
            TPE1: 'Beta',
            TPOS: '2',
            TRCK: '1',
            TCON: 'Jazz',
          }],
          ['Music/Copy/song.mp3', {
            TALB: 'Same',
            TPE1: 'Beta',
            TDRC: '2010',
            TCON: 'Rock',
          }],
          ['Second/Copy/song.mp3', {
            TALB: 'Same',
            TPE1: 'Beta',
            TDRC: '2010',
            TCON: 'Jazz',
          }],
          ['Music/Ahead/song.mp3', {
            TALB: 'Ahead',
            TPE1: 'Alpha',
            TDRC: '1990',
            TCON: 'Pop',
          }],
          ['Music/Loose/no_title_here.mp3', {}],
          ['Music/Various/one.mp3', { TALB: 'Various', TPE1: 'One' }],
          ['Music/Various/two.mp3', { TALB: 'Various', TPE1: 'Two' }],
        ];
        for (const [path, tags] of tracks) {
          await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`, {
            recursive: true,
          });
          await tagged(`${root}/${path}`, tags);
        }
        await scanLibrary(f.store);
        await Deno.mkdir(`${root}/Second/Later`);
        await tagged(`${root}/Second/Later/song.mp3`, {
          TALB: 'Zed',
          TPE1: 'Zulu',
          TDRC: '2030',
          TCON: 'Jazz',
        });
        await scanLibrary(f.store);
        const library = createLibrary(f.store);
        albums = await library.listAlbums({
          sort: 'name',
          size: 100,
          offset: 0,
        });
        assertEquals(albums.length, 7);
        return { libraries, library };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    const libraries = await f.store.catalog.listLibraries();
    return {
      ...f,
      root,
      albums,
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

type Fixture = Awaited<ReturnType<typeof albumFixture>>;
async function read(f: Fixture, credential: string, query = '') {
  const response = await f.get(`${base}${query}`, credential, {
    Origin: 'http://foreign.home',
  });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}
function ids(albums: { id: string }[]): string[] {
  return albums.map((album) => album.id);
}

Deno.test('API albums: bounded name pages have exact totals, stable ID ties and canonical validators', async () => {
  const f = await albumFixture();
  try {
    const expected = [
      f.albums.find((a) => a.name === 'Ahead')!,
      f.albums.find((a) => a.name === null)!,
      ...f.albums.filter((a) => a.name === 'Same').sort((a, b) =>
        a.id < b.id ? -1 : 1
      ),
      f.albums.find((a) => a.name === 'Various')!,
      f.albums.find((a) => a.name === 'Zed')!,
    ];
    let common;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const all = await read(f, credential);
      assertEquals(Object.keys(all).sort(), [
        'albums',
        'limit',
        'offset',
        'total',
      ]);
      assertEquals(all.total, 7);
      assertEquals(all.offset, 0);
      assertEquals(all.limit, 50);
      assertEquals(ids(all.albums), ids(expected));
      if (common) assertEquals(all, common);
      common = all;
      const paged = [];
      for (const offset of [0, 2, 4, 6, 8]) {
        const page = await read(f, credential, `?limit=2&offset=${offset}`);
        assertEquals(page.total, 7);
        assertEquals(page.limit, 2);
        assertEquals(page.offset, offset);
        assertEquals(ids(page.albums), ids(expected.slice(offset, offset + 2)));
        paged.push(...page.albums);
      }
      assertEquals(paged, all.albums);
    }
    const admin = await f.login('bearer');
    assertEquals(await read(f, admin.credential), common);
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API albums: artist, year, newest and genre eligibility precede bounded paging', async () => {
  const f = await albumFixture();
  try {
    const same = f.albums.filter((a) => a.name === 'Same').sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    const ahead = f.albums.find((a) => a.name === 'Ahead')!;
    const later = f.albums.find((a) => a.name === 'Zed')!;
    const unknown = f.albums.find((a) => a.name === null)!;
    const various = f.albums.find((a) => a.name === 'Various')!;
    const multi = same.find((a) => a.songCount === 3)!;
    const copies = same.filter((a) => a.songCount === 1);
    const second = f.libraries.find((l) => l.name === 'Second')!;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      assertEquals(
        ids((await read(f, credential, '?sort=artist')).albums),
        ids([ahead, ...same, later, unknown, various]),
      );
      assertEquals(
        ids((await read(f, credential, '?sort=year')).albums),
        ids([ahead, ...copies, multi, later, unknown, various]),
      );
      assertEquals(
        ids((await read(f, credential, '?sort=newest&limit=1')).albums),
        [later.id],
      );
      assert(
        later.createdAtMs! > Math.max(
          ...f.albums.filter((a) => a.id !== later.id).map((a) =>
            a.createdAtMs!
          ),
        ),
      );
      const range = await read(
        f,
        credential,
        '?sort=year&fromYear=1999&toYear=2010&limit=1&offset=2',
      );
      assertEquals(range.total, 3);
      assertEquals(ids(range.albums), [multi.id]); // any matching track admits the whole album
      assertEquals(range.albums[0].songCount, 3);
      const genre = await read(
        f,
        credential,
        '?sort=genre&genre=Jazz&limit=1&offset=1',
      );
      const jazz = same.filter((a) =>
        a.id === multi.id || a.metadata!.genres.includes('Jazz')
      );
      assertEquals(genre.total, 3);
      assertEquals(ids(genre.albums), [jazz[1].id]);
      const filtered = await read(
        f,
        credential,
        `?library=${second.id}&genre=Jazz&fromYear=2010&toYear=2030&limit=1&offset=1`,
      );
      assertEquals(filtered.total, 2);
      assertEquals(ids(filtered.albums), [later.id]);
      assertEquals((await read(f, credential, '?fromYear=2030')).total, 1);
      assertEquals((await read(f, credential, '?toYear=1990')).total, 1);
      const missing = await read(f, credential, '?genre=Nope&offset=100');
      assertEquals(missing, { albums: [], total: 0, limit: 50, offset: 100 });
    }
  } finally {
    await f.close();
  }
});

Deno.test('API albums: opening scoped albums agrees with counts, safe metadata and disc/track order', async () => {
  const f = await albumFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const library of f.libraries) {
        const page = await read(f, credential, `?library=${library.id}`);
        assertEquals(
          page.total,
          library.name === 'Music' ? 5 : library.name === 'Second' ? 2 : 0,
        );
        for (const summary of page.albums) {
          const response = await f.get(
            `${base}/${summary.id}?library=${library.id}`,
            credential,
            { Origin: 'http://foreign.home' },
          );
          assertEquals(response.status, 200);
          const body = await response.json();
          assertEquals(Object.keys(body), ['album']);
          const { songs, ...album } = body.album;
          assertEquals(album, summary);
          assertEquals(songs.length, album.songCount);
          assertEquals(
            songs.reduce(
              (sum: number, song: { durationMs: number }) =>
                sum + (song.durationMs ?? 0),
              0,
            ),
            album.durationMs,
          );
          assert(
            songs.every((song: { libraryId: string }) =>
              song.libraryId === library.id
            ),
          );
          const plain = await f.get(`${base}/${album.id}`, credential);
          assertEquals(await plain.json(), body);
          assert(!JSON.stringify(body).includes(f.root));
          for (const value of [album, ...songs]) {
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
            ) assert(!(key in value), key);
          }
          if (album.songCount === 3) {
            assertEquals(album.name, 'Same');
            assertEquals(album.folderName, 'Multi');
            assertEquals(album.artistKind, 'tagged');
            assertEquals(album.artistLabel, 'Beta');
            assertEquals(album.metadata.genres, ['Rock', 'Jazz']);
            assertEquals(songs.map((song: { path: string }) => song.path), [
              'Multi/CD1/z.mp3',
              'Multi/CD1/a.mp3',
              'Multi/CD2/b.mp3',
            ]);
            for (const song of songs) {
              const detail = await f.get(
                `/api/v1/songs/${song.id}`,
                credential,
              );
              assertEquals((await detail.json()).song, song);
            }
          }
          if (album.name === null) {
            assertEquals(album.label, '[Loose]');
            assertEquals(album.artistKind, 'unknown');
            assertEquals(album.artistName, null);
            assertEquals(album.artistLabel, '[Unknown Artist]');
            assertEquals(songs[0].label, '[no title here]');
          }
          if (album.name === 'Various') {
            assertEquals(album.artistKind, 'various');
            assertEquals(album.artistId, null);
            assertEquals(album.artistName, null);
            assertEquals(album.artistLabel, '[Various Artists]');
          }
        }
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API albums: query-specific conditional reads authenticate and revalidate after publication', async () => {
  const f = await albumFixture();
  try {
    const second = f.libraries.find((l) => l.name === 'Second')!;
    const album = f.albums.find((a) => a.name === 'Zed')!;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const validators = new Set();
      for (
        const query of [
          '',
          '?limit=1',
          '?offset=1',
          '?sort=artist',
          '?sort=year',
          '?sort=newest',
          '?genre=Jazz',
          '?fromYear=2010',
          '?toYear=2010',
          `?library=${second.id}`,
          `/${album.id}`,
          `/${album.id}?library=${second.id}`,
        ]
      ) {
        const response = await f.get(`${base}${query}`, credential);
        assertEquals(response.status, 200);
        const etag = response.headers.get('etag')!;
        assert(etag.startsWith('W/"'));
        assertEquals(
          response.headers.get('cache-control'),
          'private, no-cache',
        );
        validators.add(etag);
        await response.json();
        const cached = await f.get(`${base}${query}`, credential, {
          'If-None-Match': etag,
        });
        assertEquals(cached.status, 304);
        assertEquals(await cached.text(), '');
        assertEquals(cached.headers.get('etag'), etag);
        assertEquals(cached.headers.get('cache-control'), 'private, no-cache');
      }
      assertEquals(validators.size, 12);
      const normal = await f.get(base, credential);
      const etag = normal.headers.get('etag')!;
      await normal.json();
      const canonical = await f.get(
        `${base}?sort=name&offset=00&limit=050`,
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
      const wrong = await f.get(`${base}?limit=1`, credential, {
        'If-None-Match': etag,
      });
      assertEquals(wrong.status, 200);
      await wrong.json();
    }
    const { credential } = await f.login(
      'bearer',
      'listener',
      'password-listener',
    );
    const beforePage = await f.get(`${base}?genre=Jazz`, credential);
    const pageEtag = beforePage.headers.get('etag')!;
    assertEquals((await beforePage.json()).total, 3);
    const before = await f.get(`${base}/${album.id}`, credential);
    const etag = before.headers.get('etag')!;
    await before.json();
    await tagged(`${f.root}/Second/Later/song.mp3`, {
      TALB: 'Renamed',
      TPE1: 'Zulu',
      TIT2: 'Changed',
      TDRC: '2030',
    });
    await scanLibrary(f.store);
    const changed = await f.get(`${base}/${album.id}`, credential, {
      'If-None-Match': etag,
    });
    assertEquals(changed.status, 200);
    assertNotEquals(changed.headers.get('etag'), etag);
    const result = (await changed.json()).album;
    assertEquals(result.name, 'Renamed');
    assertEquals(result.songs[0].title, 'Changed');
    const changedPage = await f.get(`${base}?genre=Jazz`, credential, {
      'If-None-Match': pageEtag,
    });
    assertEquals(changedPage.status, 200);
    assertNotEquals(changedPage.headers.get('etag'), pageEtag);
    assertEquals((await changedPage.json()).total, 2);
  } finally {
    await f.close();
  }
});

Deno.test('API albums: strict query validation, missing resources and explicit auth precedence', async () => {
  const f = await albumFixture();
  try {
    const album = f.albums.find((a) => a.name === 'Ahead')!;
    const second = f.libraries.find((l) => l.name === 'Second')!;
    const cookie =
      (await f.login('cookie', 'listener', 'password-listener')).credential;
    for (const path of [base, `${base}/${album.id}`]) {
      await error(await f.get(path), 401, 'unauthenticated');
      await error(
        await f.get(path, cookie, {
          Authorization: 'Bearer invalid',
          'If-None-Match': '*',
        }),
        401,
        'unauthenticated',
      );
    }
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (
        const query of [
          '?unknown=1',
          '?limit=1&limit=2',
          '?library=a&library=b',
          '?sort=name&sort=year',
          '?limit=0',
          '?limit=501',
          '?offset=-1',
          '?offset=1.5',
          '?offset=9007199254740992',
          '?limit=1e2',
          '?limit=',
          '?sort=',
          '?sort=random',
          '?sort=unsupported',
          '?sort=name%20DESC',
          '?genre=',
          '?sort=genre',
          '?fromYear=-1',
          '?toYear=1.1',
          '?fromYear=2024&toYear=2000',
          '?library=',
        ]
      ) {
        await error(
          await f.get(base + query, credential, { 'If-None-Match': '*' }),
          400,
          'invalid_field',
        );
      }
      for (
        const query of [
          '?limit=1',
          '?unknown=1',
          '?library=',
          '?library=a&library=b',
        ]
      ) {
        await error(
          await f.get(`${base}/${album.id}${query}`, credential, {
            'If-None-Match': '*',
          }),
          400,
          'invalid_field',
        );
      }
      for (
        const path of [
          `${base}/missing`,
          `${base}?library=missing`,
          `${base}/${album.id}?library=missing`,
          `${base}/${album.id}?library=${second.id}`,
        ]
      ) {
        await error(
          await f.get(path, credential, { 'If-None-Match': '*' }),
          404,
          'not_found',
        );
      }
      for (const path of [base, `${base}/${album.id}`]) {
        const unsupported = await f.json(path, 'POST', {}, credential);
        await error(unsupported, 405, 'method_not_allowed');
        assertEquals(unsupported.headers.get('allow'), 'GET');
      }
    }
    await f.state.set('melofon.browseMaxPageRecords', '2');
    await f.state.set('melofon.browsePageRecords', '3');
    const page = await read(f, cookie);
    assertEquals(page.limit, 2);
    assertEquals(page.albums.length, 2);
    assertEquals(page.total, 7);
    await error(await f.get(`${base}?limit=3`, cookie), 400, 'invalid_field');
  } finally {
    await f.close();
  }
});

Deno.test('API albums: empty catalog and existing core list/detail signatures remain valid', async () => {
  const f = await apiFixture({
    services: (f) => Promise.resolve({ library: createLibrary(f.store) }),
  });
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(use);
      const response = await f.get(`${base}?offset=100&limit=2`, credential);
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        albums: [],
        total: 0,
        offset: 100,
        limit: 2,
      });
    }
  } finally {
    await f.close();
  }
  const populated = await albumFixture();
  try {
    const library = createLibrary(populated.store);
    const old = await library.listAlbums({ sort: 'name', size: 2, offset: 1 });
    const page = await library.albumsPage({
      sort: 'name',
      limit: 2,
      offset: 1,
    });
    assertEquals(page.rows, old);
    for (const album of populated.albums) {
      assertEquals(
        (await library.getAlbumSnapshot(album.id)).detail,
        await library.getAlbum(album.id),
      );
    }
  } finally {
    await populated.close();
  }
});
