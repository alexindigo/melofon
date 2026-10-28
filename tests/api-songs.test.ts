import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary, type SongRow } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';

const base = '/api/v1/songs';

async function songFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-songs-' });
  let songs: SongRow[] = [];
  try {
    const f = await apiFixture({
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        for (const name of ['Music', 'Second', 'Empty']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        const tracks: [string, Record<string, string>][] = [
          ['Music/z-first.mp3', {
            TIT2: 'Same',
            TPE1: 'Beta',
            TDRC: '2000',
            TCON: 'Jazz',
            TSOT: 'Before everything',
            TSOP: 'A sorted artist',
          }],
          ['Music/a-second.mp3', {
            TIT2: 'Same',
            TPE1: 'Beta',
            TDRC: '2010',
            TCON: 'Jazz',
          }],
          ['Music/c-outside.mp3', {
            TIT2: 'Alpha',
            TPE1: 'Alpha',
            TDRC: '2000',
            TCON: 'Rock',
          }],
          ['Music/loose_name.mp3', {}],
          ['Second/shared.mp3', {
            TIT2: 'Same',
            TPE1: 'Beta',
            TDRC: '2000',
            TCON: 'Jazz',
          }],
        ];
        for (const [path, tags] of tracks) {
          await tagged(`${root}/${path}`, tags);
        }
        await scanLibrary(f.store);
        await tagged(`${root}/Music/b-later.mp3`, {
          TIT2: 'Later',
          TPE1: 'Zulu',
          TDRC: '2020',
          TCON: 'Jazz',
        });
        // Recently added means observation time, never the filesystem clock.
        const old = new Date('2001-01-01T00:00:00Z');
        await Deno.utime(`${root}/Music/b-later.mp3`, old, old);
        await scanLibrary(f.store);
        const library = createLibrary(f.store);
        songs = await library.listSongs({ offset: 0, size: 100 });
        assertEquals(songs.length, 6);
        return { libraries, library };
      },
    });
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    return {
      ...f,
      root,
      songs,
      libraries: await f.store.catalog.listLibraries(),
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

type Fixture = Awaited<ReturnType<typeof songFixture>>;
const ids = (rows: { id: string }[]): string[] => rows.map((row) => row.id);
const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : 1;
async function read(f: Fixture, credential: string, query = '') {
  const response = await f.get(base + query, credential, {
    Origin: 'http://foreign.home',
  });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}

Deno.test('API songs: bounded pages partition stable title/ID order and match safe details for both credentials', async () => {
  const f = await songFixture();
  try {
    const expected = [
      f.songs.find((s) => s.title === 'Alpha')!,
      f.songs.find((s) => s.title === 'Later')!,
      ...f.songs.filter((s) => s.title === 'Same').sort(byId),
      f.songs.find((s) => s.title === null)!,
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
        'limit',
        'offset',
        'songs',
        'total',
      ]);
      assertEquals([all.total, all.offset, all.limit], [6, 0, 50]);
      assertEquals(ids(all.songs), ids(expected));
      if (common) assertEquals(all, common);
      common = all;
      const joined = [];
      for (const offset of [0, 2, 4, 6, 100]) {
        const page = await read(f, credential, `?offset=${offset}&limit=2`);
        assertEquals([page.total, page.offset, page.limit], [6, offset, 2]);
        assertEquals(ids(page.songs), ids(expected.slice(offset, offset + 2)));
        joined.push(...page.songs);
      }
      assertEquals(joined, all.songs);
      for (const song of all.songs) {
        const detail = await f.get(`${base}/${song.id}`, credential);
        assertEquals(detail.status, 200);
        assertEquals((await detail.json()).song, song);
        assert(!JSON.stringify(song).includes(f.root));
        for (
          const key of [
            'libraryPath',
            'starred',
            'userRating',
            'averageRating',
            'playCount',
            'played',
            'lastPlayed',
          ]
        ) assert(!(key in song), key);
        assertEquals(song.contentType, 'audio/mpeg');
        assertEquals(song.metadata.sampleRate, 44100);
        if (song.title === null) {
          assertEquals(song.label, '[loose name]');
          assertEquals(song.path, 'loose_name.mp3');
          assertEquals(song.artistName, null);
        }
      }
    }
    const admin = await f.login('bearer');
    assertEquals(await read(f, admin.credential), common);
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API songs: library, genre and inclusive year predicates compose before paging in every mode', async () => {
  const f = await songFixture();
  try {
    const music = f.libraries.find((l) => l.name === 'Music')!;
    const second = f.libraries.find((l) => l.name === 'Second')!;
    const same = f.songs.filter((s) => s.title === 'Same').sort(byId);
    const alpha = f.songs.find((s) => s.title === 'Alpha')!;
    const later = f.songs.find((s) => s.title === 'Later')!;
    const unknown = f.songs.find((s) => s.title === null)!;
    const years = same.filter((s) => s.year === 2000);
    const year2010 = same.find((s) => s.year === 2010)!;
    const eligible = same.filter((s) => s.libraryId === music.id);
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      assertEquals(
        ids((await read(f, credential, '?sort=artist')).songs),
        ids([alpha, ...same, later, unknown]),
      );
      assertEquals(
        ids((await read(f, credential, '?sort=year')).songs),
        ids([alpha, ...years, year2010, later, unknown]),
      );
      assertEquals(
        ids((await read(f, credential, '?sort=genre&genre=Jazz')).songs),
        ids([later, ...same]),
      );
      const query = `?library=${music.id}&genre=Jazz&fromYear=2000&toYear=2010`;
      const page = await read(f, credential, `${query}&offset=1&limit=1`);
      assertEquals(page.total, 2);
      assertEquals(ids(page.songs), [eligible[1].id]);
      assertEquals(await read(f, credential, `${query}&offset=100&limit=1`), {
        songs: [],
        total: 2,
        offset: 100,
        limit: 1,
      });
      assertEquals((await read(f, credential, '?fromYear=2010')).total, 2);
      assertEquals((await read(f, credential, '?toYear=2000')).total, 3);
      assertEquals(
        (await read(f, credential, '?fromYear=2000&toYear=2000')).total,
        3,
      );
      const scoped = await read(f, credential, `?library=${second.id}`);
      assertEquals(scoped.total, 1);
      assertEquals(
        ids(scoped.songs),
        ids(same.filter((s) => s.libraryId === second.id)),
      );
      for (
        const query of [
          '?genre=Nope',
          "?genre=Jazz'%20OR%201=1--",
          `?library=${second.id}&fromYear=2020`,
          `?library=${f.libraries.find((l) => l.name === 'Empty')!.id}`,
        ]
      ) {
        assertEquals((await read(f, credential, query)).total, 0);
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API songs: recently added uses retained firstSeen after move and retag, independently of mtime', async () => {
  const f = await songFixture();
  try {
    const later = f.songs.find((s) => s.title === 'Later')!;
    const first = f.songs.find((s) => s.fileName === 'z-first')!;
    assert(
      later.firstSeenMs! > Math.max(
        ...f.songs.filter((s) => s.id !== later.id).map((s) => s.firstSeenMs!),
      ),
    );
    const { credential } = await f.login(
      'cookie',
      'listener',
      'password-listener',
    );
    const before = await read(f, credential, '?sort=newest');
    assertEquals(
      ids(before.songs),
      ids([
        later,
        ...f.songs.filter((s) => s.id !== later.id).sort((a, b) =>
          b.firstSeenMs! - a.firstSeenMs! || byId(a, b)
        ),
      ]),
    );
    await Deno.mkdir(`${f.root}/Music/Moved`);
    await Deno.rename(
      `${f.root}/Music/z-first.mp3`,
      `${f.root}/Music/Moved/retagged.mp3`,
    );
    await scanLibrary(f.store);
    await tagged(`${f.root}/Music/Moved/retagged.mp3`, {
      TIT2: 'Retagged',
      TPE1: 'Beta',
      TDRC: '2000',
      TCON: 'Jazz',
    });
    const future = new Date('2040-01-01T00:00:00Z');
    await Deno.utime(`${f.root}/Music/Moved/retagged.mp3`, future, future);
    await scanLibrary(f.store);
    const newerMtime = (await Deno.stat(`${f.root}/Music/Moved/retagged.mp3`))
      .mtime!;
    const olderMtime = (await Deno.stat(`${f.root}/Music/b-later.mp3`)).mtime!;
    assert(newerMtime.getTime() > olderMtime.getTime());
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const after = await read(f, credential, '?sort=newest');
      assertEquals(ids(after.songs), ids(before.songs));
      const moved = after.songs.find((s: { id: string }) => s.id === first.id)!;
      assertEquals(moved.firstSeenMs, first.firstSeenMs);
      assertEquals(moved.path, 'Moved/retagged.mp3');
      assertEquals(moved.title, 'Retagged');
      const detail = await f.get(`${base}/${first.id}`, credential);
      assertEquals((await detail.json()).song, moved);
      assertEquals(
        ids((await read(f, credential, '?sort=newest&limit=1')).songs),
        [later.id],
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('API songs: canonical query-specific validators revalidate filtered rows and totals after scan', async () => {
  const f = await songFixture();
  try {
    const music = f.libraries.find((l) => l.name === 'Music')!;
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      const etags = new Set();
      for (
        const query of [
          '',
          '?offset=1',
          '?limit=1',
          '?sort=artist',
          '?sort=year',
          '?sort=newest',
          '?genre=Jazz',
          '?fromYear=2000',
          '?toYear=2010',
          `?library=${music.id}`,
        ]
      ) {
        const response = await f.get(base + query, credential);
        assertEquals(response.status, 200);
        const etag = response.headers.get('etag')!;
        assert(etag.startsWith('W/"'));
        etags.add(etag);
        assertEquals(
          response.headers.get('cache-control'),
          'private, no-cache',
        );
        await response.json();
        const cached = await f.get(base + query, credential, {
          'If-None-Match': etag,
          Origin: 'http://foreign.home',
        });
        assertEquals(cached.status, 304);
        assertEquals(await cached.text(), '');
        assertEquals(cached.headers.get('etag'), etag);
        assertEquals(cached.headers.get('cache-control'), 'private, no-cache');
      }
      assertEquals(etags.size, 10);
      const response = await f.get(base, credential);
      const etag = response.headers.get('etag')!;
      await response.json();
      const canonical = await f.get(
        `${base}?sort=name&offset=00&limit=050`,
        credential,
        {
          'If-None-Match': etag,
        },
      );
      assertEquals(canonical.status, 304);
      await canonical.text();
      const other = await f.get(`${base}?limit=1`, credential, {
        'If-None-Match': etag,
      });
      assertEquals(other.status, 200);
      await other.json();
      const albums = await f.get('/api/v1/albums', credential, {
        'If-None-Match': etag,
      });
      assertEquals(albums.status, 200);
      assertNotEquals(albums.headers.get('etag'), etag);
      await albums.json();
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
    const before = await f.get(`${base}?genre=Jazz`, credential);
    const etag = before.headers.get('etag')!;
    assertEquals((await before.json()).total, 4);
    await tagged(`${f.root}/Music/b-later.mp3`, {
      TIT2: 'Changed',
      TPE1: 'Zulu',
      TDRC: '2020',
      TCON: 'Rock',
    });
    await scanLibrary(f.store);
    const after = await f.get(`${base}?genre=Jazz`, credential, {
      'If-None-Match': etag,
    });
    assertEquals(after.status, 200);
    assertNotEquals(after.headers.get('etag'), etag);
    const page = await after.json();
    assertEquals(page.total, 3);
    assertEquals(
      ids(page.songs),
      ids(f.songs.filter((s) => s.title === 'Same').sort(byId)),
    );
  } finally {
    await f.close();
  }
});

Deno.test('API songs: strict queries, missing libraries, auth precedence and live page limits', async () => {
  const f = await songFixture();
  try {
    await error(await f.get(base), 401, 'unauthenticated');
    const cookie =
      (await f.login('cookie', 'listener', 'password-listener')).credential;
    await error(
      await f.get(base, cookie, {
        Authorization: 'Bearer invalid',
        'If-None-Match': '*',
      }),
      401,
      'unauthenticated',
    );
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (
        const query of [
          '?unknown=1',
          '?offset=1&offset=2',
          '?limit=1&limit=2',
          '?library=a&library=b',
          '?genre=Jazz&genre=Rock',
          '?fromYear=2000&fromYear=2001',
          '?toYear=2000&toYear=2001',
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
          '?sort=recent',
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
      await error(
        await f.get(`${base}?library=missing`, credential, {
          'If-None-Match': '*',
        }),
        404,
        'not_found',
      );
      const unsupported = await f.json(base, 'POST', {}, credential);
      await error(unsupported, 405, 'method_not_allowed');
      assertEquals(unsupported.headers.get('allow'), 'GET');
    }
    await f.state.set('melofon.browseMaxPageRecords', '2');
    await f.state.set('melofon.browsePageRecords', '3');
    const page = await read(f, cookie);
    assertEquals([page.limit, page.songs.length, page.total], [2, 2, 6]);
    await error(await f.get(`${base}?limit=3`, cookie), 400, 'invalid_field');
  } finally {
    await f.close();
  }
});

Deno.test('API songs: an empty catalog keeps exact out-of-range totals and legacy walks retain path order', async () => {
  const f = await apiFixture({
    services: (f) => Promise.resolve({ library: createLibrary(f.store) }),
  });
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(use);
      const response = await f.get(`${base}?offset=100&limit=2`, credential);
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        songs: [],
        total: 0,
        offset: 100,
        limit: 2,
      });
    }
  } finally {
    await f.close();
  }
  const populated = await songFixture();
  try {
    const library = createLibrary(populated.store);
    assertEquals(
      await library.listSongs({ offset: 1, size: 2 }),
      populated.songs.slice(1, 3),
    );
    const jazz = await library.songsByGenre('Jazz', { size: 2, offset: 1 });
    const page = await library.songsPage({
      sort: 'genre',
      genre: 'Jazz',
      limit: 2,
      offset: 1,
    });
    assertEquals(page.rows, jazz);
    assertEquals(page.total, 4);
  } finally {
    await populated.close();
  }
});
