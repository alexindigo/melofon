import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';

const genres = '/api/v1/genres';
const statistics = '/api/v1/statistics';

async function statisticsFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-statistics-' });
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        for (const name of ['Music', 'Second', 'Empty']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        const tracks: [string, Record<string, string>][] = [
          ['Music/Main/a.mp3', {
            TALB: 'Main',
            TPE2: 'Shared',
            TPE1: 'Guest',
            TCON: 'Jazz\0Fusion',
          }],
          ['Music/Main/b.mp3', {
            TALB: 'Main',
            TPE2: 'Shared',
            TPE1: 'Shared',
            TCON: 'Jazz',
          }],
          ['Second/Shared/a.mp3', {
            TALB: 'Other',
            TPE1: 'Shared',
            TCON: 'Jazz',
          }],
          ['Music/Mix/a.mp3', { TALB: 'Mix', TPE1: 'One', TCON: 'Rock' }],
          ['Music/Mix/b.mp3', { TALB: 'Mix', TPE1: 'Two', TCON: 'Jazz' }],
          ['Music/Unknown/a.mp3', {}],
          ['Second/RealVA/a.mp3', {
            TALB: 'Tagged',
            TPE2: 'Various Artists',
            TPE1: 'Guest',
            TCON: "R'n'B",
          }],
        ];
        for (const [path, tags] of tracks) {
          await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`, {
            recursive: true,
          });
          await tagged(`${root}/${path}`, tags);
        }
        await Deno.mkdir(`${root}/Second/Video`);
        await Deno.copyFile(
          'tests/fixtures/library/Fixture Artist/Fixture Album/03 - Clip.mp4',
          `${root}/Second/Video/clip.mp4`,
        );
        await scanLibrary(f.store);
        return { libraries, library: createLibrary(f.store) };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    const libraries = await f.store.catalog.listLibraries();
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    assertEquals(songs.length, 8);
    return {
      ...f,
      root,
      libraries,
      songs,
      async close() {
        await f.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (e) {
    await Deno.remove(root, { recursive: true });
    throw e;
  }
}

type Fixture = Awaited<ReturnType<typeof statisticsFixture>>;
async function read(f: Fixture, credential: string, path: string) {
  const response = await f.get(path, credential, {
    Origin: 'http://foreign.home',
  });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}
function duration(songs: SongRow[]) {
  assert(
    songs.every((song) => song.durationMs !== null && song.durationMs > 0),
  );
  return songs.reduce((n, song) => n + song.durationMs!, 0);
}

Deno.test('API statistics: live global and scoped facts count shared credits once and videos within songs', async () => {
  const f = await statisticsFixture();
  try {
    const music = f.libraries.find((l) => l.name === 'Music')!;
    const second = f.libraries.find((l) => l.name === 'Second')!;
    const expected = {
      songCount: 8,
      videoCount: 1,
      albumCount: 6,
      artistCount: 6,
      browseArtistCount: 5,
      durationMs: duration(f.songs),
    };
    let common;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const global = await read(f, credential, statistics);
      assertEquals(global, { statistics: expected });
      common = global;
      const scoped = [];
      for (
        const [library, counts] of [
          [music, {
            songCount: 5,
            videoCount: 0,
            albumCount: 3,
            artistCount: 4,
            browseArtistCount: 3,
          }],
          [second, {
            songCount: 3,
            videoCount: 1,
            albumCount: 3,
            artistCount: 4,
            browseArtistCount: 3,
          }],
        ] as const
      ) {
        const selected =
          (await read(f, credential, `${statistics}?library=${library.id}`))
            .statistics;
        assertEquals(selected, {
          ...counts,
          durationMs: duration(
            f.songs.filter((s) => s.libraryId === library.id),
          ),
        });
        const songs = await read(
          f,
          credential,
          `/api/v1/songs?library=${library.id}`,
        );
        const albums = await read(
          f,
          credential,
          `/api/v1/albums?library=${library.id}`,
        );
        const artists = await read(
          f,
          credential,
          `/api/v1/artists?library=${library.id}`,
        );
        assertEquals(selected.songCount, songs.total);
        assertEquals(
          selected.videoCount,
          songs.songs.filter((s: SongRow) => s.isVideo).length,
        );
        assertEquals(selected.albumCount, albums.total);
        assertEquals(selected.browseArtistCount, artists.total);
        assertEquals(
          selected.durationMs,
          albums.albums.reduce(
            (n: number, a: { durationMs: number }) => n + a.durationMs,
            0,
          ),
        );
        scoped.push(selected);
      }
      assertEquals(scoped[0].artistCount + scoped[1].artistCount, 8);
      assertEquals(global.statistics.artistCount, 6); // Shared and Guest occur in both libraries.
    }
    const admin = await f.login('bearer');
    assertEquals(await read(f, admin.credential, statistics), common);
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
    assert(f.origin.startsWith('http://melofon.home:'));
  } finally {
    await f.close();
  }
});

Deno.test('API genres: bounded primary-genre counts scope before paging and match song and album filters', async () => {
  const f = await statisticsFixture();
  try {
    const expected = [
      { name: 'Jazz', songCount: 4, albumCount: 3 },
      { name: "R'n'B", songCount: 1, albumCount: 1 },
      { name: 'Rock', songCount: 1, albumCount: 1 },
    ];
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      assertEquals(await read(f, credential, genres), {
        genres: expected,
        total: 3,
        offset: 0,
        limit: 50,
      });
      const pages = [];
      for (let offset = 0; offset < 3; offset++) {
        const page = await read(
          f,
          credential,
          `${genres}?limit=1&offset=${offset}`,
        );
        assertEquals(page, {
          genres: [expected[offset]],
          total: 3,
          limit: 1,
          offset,
        });
        pages.push(...page.genres);
      }
      assertEquals(pages, expected);
      assertEquals(await read(f, credential, `${genres}?offset=99&limit=2`), {
        genres: [],
        total: 3,
        offset: 99,
        limit: 2,
      });
      for (const library of f.libraries) {
        const scoped = await read(
          f,
          credential,
          `${genres}?library=${library.id}`,
        );
        const wanted = library.name === 'Music'
          ? [{ name: 'Jazz', songCount: 3, albumCount: 2 }, expected[2]]
          : library.name === 'Second'
          ? [{ name: 'Jazz', songCount: 1, albumCount: 1 }, expected[1]]
          : [];
        assertEquals(scoped, {
          genres: wanted,
          total: wanted.length,
          offset: 0,
          limit: 50,
        });
        for (const genre of scoped.genres) {
          const query = `library=${library.id}&genre=${
            encodeURIComponent(genre.name)
          }`;
          assertEquals(
            (await read(f, credential, `/api/v1/songs?${query}`)).total,
            genre.songCount,
          );
          assertEquals(
            (await read(f, credential, `/api/v1/albums?${query}`)).total,
            genre.albumCount,
          );
        }
      }
      // Secondary indexed metadata is not a second primary genre/filter bucket.
      const multi = f.songs.find((s) => s.metadata?.genres.length === 2)!;
      const detail = await read(f, credential, `/api/v1/songs/${multi.id}`);
      assertEquals(detail.song.metadata.genres, ['Jazz', 'Fusion']);
      assertEquals(
        (await read(f, credential, '/api/v1/songs?genre=Fusion')).total,
        0,
      );
    }
    assertEquals(await f.store.catalog.listGenres(), expected); // Legacy shape/policy preserved.
  } finally {
    await f.close();
  }
});

Deno.test('API catalog statistics: conditional genre/statistic reads use canonical scoped representations', async () => {
  const f = await statisticsFixture();
  try {
    const library = f.libraries.find((l) => l.name === 'Music')!.id;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const tags = new Set<string>();
      for (
        const path of [
          genres,
          `${genres}?library=${library}`,
          `${genres}?limit=1`,
          statistics,
          `${statistics}?library=${library}`,
        ]
      ) {
        const first = await f.get(path, credential);
        assertEquals(first.status, 200);
        const tag = first.headers.get('etag')!;
        assert(/^W\/"[a-f0-9]{64}"$/.test(tag));
        assert(!tags.has(tag));
        tags.add(tag);
        assertEquals(first.headers.get('cache-control'), 'private, no-cache');
        await first.json();
        const repeat = await f.get(path, credential, {
          'If-None-Match': tag,
          Origin: 'http://foreign.home',
        });
        assertEquals(repeat.status, 304);
        assertEquals(await repeat.text(), '');
        assertEquals(repeat.headers.get('etag'), tag);
        assertEquals(repeat.headers.get('cache-control'), 'private, no-cache');
        await error(
          await f.get(path, undefined, { 'If-None-Match': tag }),
          401,
          'unauthenticated',
        );
      }
      const defaults = await f.get(
        `${genres}?sort=name&limit=050&offset=00`,
        credential,
      );
      const implicit = await f.get(genres, credential);
      assertEquals(defaults.headers.get('etag'), implicit.headers.get('etag'));
      const admin = await f.login('bearer');
      const same = await f.get(genres, admin.credential);
      assertEquals(same.headers.get('etag'), implicit.headers.get('etag'));
      await Promise.all([defaults.text(), implicit.text(), same.text()]);
    }
  } finally {
    await f.close();
  }
});

Deno.test('API catalog statistics: removal changes live aggregates and validators without another scan', async () => {
  const f = await statisticsFixture();
  try {
    const listener = await f.login('cookie', 'listener', 'password-listener');
    const bearer = await f.login('bearer', 'listener', 'password-listener');
    const admin = await f.login('bearer');
    const second = f.libraries.find((l) => l.name === 'Second')!;
    const paths = [
      statistics,
      genres,
      `${statistics}?library=${second.id}`,
      `${genres}?library=${second.id}`,
    ];
    const previous = new Map<string, string>();
    for (const path of paths) {
      const response = await f.get(path, listener.credential);
      previous.set(path, response.headers.get('etag')!);
      await response.text();
    }
    const scanSnapshot = await f.store.scan.stats(second.id);
    assertEquals(scanSnapshot?.songs, 3);
    const removed = await f.json(
      `/api/v1/admin/libraries/${second.id}`,
      'DELETE',
      undefined,
      admin.credential,
    );
    assertEquals(removed.status, 204, await removed.clone().text());
    await removed.text();
    assertEquals(await f.store.scan.stats(second.id), scanSnapshot); // Historical acquisition record stays historical.
    for (const credential of [listener.credential, bearer.credential]) {
      for (const path of paths.slice(2)) {
        await error(
          await f.get(path, credential, {
            'If-None-Match': previous.get(path)!,
          }),
          404,
          'not_found',
        );
      }
      for (const path of paths.slice(0, 2)) {
        const response = await f.get(path, credential, {
          'If-None-Match': previous.get(path)!,
        });
        assertEquals(response.status, 200);
        assertNotEquals(response.headers.get('etag'), previous.get(path));
        const body = await response.json();
        assertEquals(
          body,
          path === statistics
            ? {
              statistics: {
                songCount: 5,
                videoCount: 0,
                albumCount: 3,
                artistCount: 4,
                browseArtistCount: 3,
                durationMs: duration(
                  f.songs.filter((s) => s.libraryId !== second.id),
                ),
              },
            }
            : {
              genres: [
                { name: 'Jazz', songCount: 3, albumCount: 2 },
                { name: 'Rock', songCount: 1, albumCount: 1 },
              ],
              total: 2,
              offset: 0,
              limit: 50,
            },
        );
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API catalog statistics: strict queries, missing scopes, auth precedence and shared page limits', async () => {
  const f = await statisticsFixture();
  try {
    const { credential } = await f.login(
      'cookie',
      'listener',
      'password-listener',
    );
    for (const path of [genres, statistics]) {
      await error(await f.get(path), 401, 'unauthenticated');
      await error(
        await f.get(path, credential, {
          Authorization: 'Bearer invalid',
          'If-None-Match': '*',
        }),
        401,
        'unauthenticated',
      );
      for (const query of ['library=', 'library=x&library=y', 'unknown=1']) {
        await error(
          await f.get(`${path}?${query}`, credential),
          400,
          'invalid_field',
        );
      }
      await error(
        await f.get(`${path}?library=missing`, credential, {
          'If-None-Match': '*',
        }),
        404,
        'not_found',
      );
      const method = await f.json(path, 'POST', {}, credential);
      assertEquals(method.headers.get('allow'), 'GET');
      await error(method, 405, 'method_not_allowed');
    }
    for (
      const query of [
        'sort=-name',
        'sort=newest',
        'limit=0',
        'limit=501',
        'limit=1&limit=2',
        'offset=-1',
        'offset=1.5',
        'offset=9007199254740992',
        'limit=+1',
        'genre=Jazz',
      ]
    ) {
      await error(
        await f.get(`${genres}?${query}`, credential),
        400,
        'invalid_field',
      );
    }
    for (const query of ['limit=1', 'offset=0', 'sort=name', 'genre=Jazz']) {
      await error(
        await f.get(`${statistics}?${query}`, credential),
        400,
        'invalid_field',
      );
    }
    await f.state.set('melofon.browseMaxPageRecords', '1');
    assertEquals((await read(f, credential, genres)).limit, 1);
    await error(
      await f.get(`${genres}?limit=2`, credential),
      400,
      'invalid_field',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API catalog statistics: empty global and selected-library views have explicit zero facts', async () => {
  const f = await apiFixture({
    services: (f) =>
      Promise.resolve({
        library: createLibrary(f.store),
        libraries: createLibraries(f.store),
      }),
  });
  try {
    const zero = {
      statistics: {
        songCount: 0,
        videoCount: 0,
        durationMs: 0,
        albumCount: 0,
        artistCount: 0,
        browseArtistCount: 0,
      },
    };
    await f.store.catalog.addLibrary({
      id: 'empty',
      name: 'Empty',
      path: '/empty',
    });
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(use);
      for (const query of ['', 'library=empty&']) {
        const response = await f.get(
          `${statistics}${query ? '?library=empty' : ''}`,
          credential,
        );
        assertEquals(response.status, 200);
        assertEquals(await response.json(), zero);
        const page = await f.get(
          `${genres}?${query}offset=90&limit=2`,
          credential,
        );
        assertEquals(page.status, 200);
        assertEquals(await page.json(), {
          genres: [],
          total: 0,
          offset: 90,
          limit: 2,
        });
      }
    }
  } finally {
    await f.close();
  }
});
