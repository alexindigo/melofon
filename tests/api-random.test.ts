import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';

async function randomFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-random-' });
  const storeDir = `${root}/store`;
  const services: NonNullable<
    NonNullable<Parameters<typeof apiFixture>[0]>['services']
  > = (f) =>
    Promise.resolve({
      libraries: createLibraries(f.store, { notify: f.notify }),
      library: createLibrary(f.store),
    });
  let current: Awaited<ReturnType<typeof apiFixture>> | undefined;
  try {
    current = await apiFixture({
      storeDir,
      services: async (f) => {
        const libraries = createLibraries(f.store, { notify: f.notify });
        for (const name of ['Music', 'Second', 'Empty']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        for (let album = 0; album < 8; album++) {
          const source = album < 6 ? 'Music' : 'Second';
          const dir = `${root}/${source}/album-${album}`;
          await Deno.mkdir(dir);
          for (let track = 0; track < 2; track++) {
            await tagged(`${dir}/${track}.mp3`, {
              TIT2: `Song ${album}-${track}`,
              TALB: `Album ${album}`,
              TPE1: 'Shared Artist',
              TPE2: 'Shared Artist',
              TCON: album === 2 ? 'Rock' : 'Jazz',
              TDRC: String(2000 + album * 5 + track),
            });
          }
        }
        await scanLibrary(f.store);
        return await services(f);
      },
    });
    const f = current;
    await f.auth.users.create(f.admin.id, {
      username: 'listener',
      password: 'password-listener',
      role: 'user',
    });
    const library = createLibrary(f.store);
    const songs = await library.listSongs({ offset: 0, size: 100 });
    const albums = await library.listAlbums({
      sort: 'name',
      offset: 0,
      size: 100,
    });
    assertEquals([songs.length, albums.length], [16, 8]);
    return {
      ...f,
      root,
      songs,
      albums,
      libraries: await f.store.catalog.listLibraries(),
      async reopen() {
        await current!.close();
        current = undefined;
        current = await apiFixture({ storeDir, services });
        return current;
      },
      async close() {
        await current?.close();
        await Deno.remove(root, { recursive: true });
      },
    };
  } catch (err) {
    await current?.close();
    await Deno.remove(root, { recursive: true });
    throw err;
  }
}

type Collection = 'albums' | 'songs';
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
const seed = "household's shuffle: é/音 + %";
const randomQuery = (value = seed) =>
  `sort=random&seed=${encodeURIComponent(value)}`;
async function read(
  f: Awaited<ReturnType<typeof apiFixture>>,
  collection: Collection,
  credential: string,
  query = randomQuery(),
) {
  const response = await f.get(`/api/v1/${collection}?${query}`, credential, {
    Origin: 'http://foreign.home',
  });
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json();
}

for (const collection of ['albums', 'songs'] as const) {
  Deno.test(`API random ${collection}: seed-stable adjacent pages partition the catalog for both credentials`, async () => {
    const f = await randomFixture();
    try {
      let common;
      for (const use of ['cookie', 'bearer'] as const) {
        const { credential } = await f.login(
          use,
          'listener',
          'password-listener',
        );
        const all = await read(f, collection, credential);
        assertEquals(
          Object.keys(all).sort(),
          [collection, 'limit', 'offset', 'total'].sort(),
        );
        assertEquals([all.total, all.offset, all.limit], [
          f[collection].length,
          0,
          50,
        ]);
        assertEquals(ids(all[collection]).sort(), ids(f[collection]).sort());
        if (common) assertEquals(all, common);
        common = all;
        const joined = [];
        for (let offset = 0; offset < all.total + 3; offset += 3) {
          const page = await read(
            f,
            collection,
            credential,
            `${randomQuery()}&offset=${offset}&limit=3`,
          );
          assertEquals([page.total, page.offset, page.limit], [
            all.total,
            offset,
            3,
          ]);
          assertEquals(
            page[collection],
            all[collection].slice(offset, offset + 3),
          );
          joined.push(...page[collection]);
        }
        assertEquals(joined, all[collection]);
        assertEquals(new Set(ids(joined)).size, all.total);
        assertEquals(await read(f, collection, credential), all);
        const other = await read(
          f,
          collection,
          credential,
          randomQuery('another seed'),
        );
        assertNotEquals(ids(other[collection]), ids(all[collection]));
        assertEquals(
          ids(other[collection]).sort(),
          ids(all[collection]).sort(),
        );
        for (const row of all[collection]) {
          const detail = await f.get(
            `/api/v1/${collection}/${row.id}`,
            credential,
          );
          assertEquals(detail.status, 200);
          const body = await detail.json();
          if (collection === 'albums') delete body.album.songs;
          assertEquals(body[collection === 'albums' ? 'album' : 'song'], row);
          assert(!JSON.stringify(row).includes(f.root));
          for (
            const key of [
              'starred',
              'userRating',
              'averageRating',
              'playCount',
              'played',
              'lastPlayed',
            ]
          ) {
            assert(!(key in row), key);
          }
        }
      }
      const admin = await f.login('bearer');
      assertEquals(await read(f, collection, admin.credential), common);
      assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
    } finally {
      await f.close();
    }
  });
}

Deno.test('API random: library, genre and inclusive year eligibility precede rank and pagination', async () => {
  const f = await randomFixture();
  try {
    const music = f.libraries.find((l) => l.name === 'Music')!;
    const empty = f.libraries.find((l) => l.name === 'Empty')!;
    const eligibleSongs = f.songs.filter((s) =>
      s.libraryId === music.id && s.genre === 'Jazz' && s.year! >= 2000 &&
      s.year! <= 2020
    );
    const eligibleAlbums = [...new Set(eligibleSongs.map((s) => s.albumId))]
      .sort();
    assertEquals([eligibleSongs.length, eligibleAlbums.length], [7, 4]);
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const collection of ['albums', 'songs'] as const) {
        const query =
          `${randomQuery()}&library=${music.id}&genre=Jazz&fromYear=2000&toYear=2020`;
        const all = await read(f, collection, credential, query);
        const expected = collection === 'albums'
          ? eligibleAlbums
          : ids(eligibleSongs).sort();
        assertEquals(ids(all[collection]).sort(), expected);
        // Restriction preserves the rank of eligible identities from the global sequence.
        const global = await read(f, collection, credential);
        assertEquals(
          ids(all[collection]),
          ids(global[collection]).filter((id) => expected.includes(id)),
        );
        const joined = [];
        for (let offset = 0; offset <= expected.length; offset++) {
          const page = await read(
            f,
            collection,
            credential,
            `${query}&offset=${offset}&limit=1`,
          );
          assertEquals([page.total, page.offset, page.limit], [
            expected.length,
            offset,
            1,
          ]);
          joined.push(...page[collection]);
        }
        assertEquals(joined, all[collection]);
        const past = await read(
          f,
          collection,
          credential,
          `${query}&offset=99&limit=1`,
        );
        assertEquals(past, {
          [collection]: [],
          total: expected.length,
          offset: 99,
          limit: 1,
        });
        for (
          const suffix of [
            `library=${empty.id}`,
            'genre=Missing',
            'fromYear=9999',
          ]
        ) {
          assertEquals(
            await read(
              f,
              collection,
              credential,
              `${randomQuery()}&${suffix}&offset=99`,
            ),
            {
              [collection]: [],
              total: 0,
              offset: 99,
              limit: 50,
            },
          );
        }
        if (collection === 'albums') {
          // Album 4 has one matching year and one outside it; eligibility admits the whole album.
          const mixed = all.albums.find((a: { name: string }) =>
            a.name === 'Album 4'
          );
          assertEquals(mixed.songCount, 2);
        }
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API random: validators include seed and page and change after catalog publication', async () => {
  const f = await randomFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const collection of ['albums', 'songs'] as const) {
        const path = `/api/v1/${collection}?${randomQuery()}`;
        const first = await f.get(path, credential);
        const before = await first.json();
        const etag = first.headers.get('etag')!;
        assert(etag.startsWith('W/"'));
        assertEquals(first.headers.get('cache-control'), 'private, no-cache');
        const repeat = await f.get(`${path}&offset=0&limit=50`, credential, {
          'If-None-Match': etag,
        });
        assertEquals(repeat.status, 304);
        assertEquals(await repeat.text(), '');
        assertEquals(repeat.headers.get('etag'), etag);
        assertEquals(
          repeat.headers.get('cache-control'),
          first.headers.get('cache-control'),
        );
        const tags = new Set([etag]);
        for (
          const query of [
            randomQuery('different'),
            `${randomQuery()}&offset=1`,
            `${randomQuery()}&limit=1`,
          ]
        ) {
          const changed = await f.get(
            `/api/v1/${collection}?${query}`,
            credential,
            { 'If-None-Match': etag },
          );
          assertEquals(changed.status, 200);
          tags.add(changed.headers.get('etag')!);
          await changed.body?.cancel();
        }
        assertEquals(tags.size, 4);
        await error(
          await f.get(path, undefined, { 'If-None-Match': etag }),
          401,
          'unauthenticated',
        );
        const file = `${f.root}/Music/added-${use}-${collection}.mp3`;
        await tagged(file, {
          TIT2: 'Added',
          TALB: `Added ${use} ${collection}`,
          TPE1: 'Shared Artist',
        });
        await scanLibrary(f.store);
        const changed = await f.get(path, credential, {
          'If-None-Match': etag,
        });
        assertEquals(changed.status, 200);
        assertNotEquals(changed.headers.get('etag'), etag);
        const after = await changed.json();
        assertEquals(after.total, before.total + 1);
        assert(
          ids(after[collection]).some((id) =>
            !ids(before[collection]).includes(id)
          ),
        );
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API random: strict seed vocabulary, authentication and source validation precede conditional responses', async () => {
  const f = await randomFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(
        use,
        'listener',
        'password-listener',
      );
      for (const collection of ['albums', 'songs'] as const) {
        const path = `/api/v1/${collection}?`;
        for (
          const query of [
            'sort=random',
            'sort=random&seed=',
            'sort=random&seed=a&seed=b',
            'seed=a',
            'sort=name&seed=a',
            'sort=newest&seed=',
            'sort=random&seed=a&sort=random',
            'sort=random&seed=a&limit=0',
            'sort=random&seed=a&offset=-1',
            'sort=random&seed=a&unknown=1',
          ]
        ) {
          await error(
            await f.get(path + query, credential, { 'If-None-Match': '*' }),
            400,
            'invalid_field',
          );
        }
        await error(
          await f.get(`${path}${randomQuery()}&library=missing`, credential, {
            'If-None-Match': '*',
          }),
          404,
          'not_found',
        );
        await error(
          await f.get(path + randomQuery(), credential, {
            Authorization: 'Bearer invalid',
          }),
          401,
          'unauthenticated',
        );
        // Opaque seeds are not numbers: zero, whitespace, case and leading zeroes are preserved.
        const tags = new Set<string>();
        for (const value of ['0', '00', 'A', 'a', ' ']) {
          const response = await f.get(path + randomQuery(value), credential);
          assertEquals(response.status, 200);
          tags.add(response.headers.get('etag')!);
          await response.body?.cancel();
        }
        assertEquals(tags.size, 5);
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API random: persistent reopen retains sequence and ETag; legacy unseeded sampling stays independent', async () => {
  const f = await randomFixture();
  try {
    const { credential } = await f.login(
      'cookie',
      'listener',
      'password-listener',
    );
    const snapshots = new Map<Collection, { body: unknown; etag: string }>();
    const library = createLibrary(f.store);
    const music = f.libraries.find((l) => l.name === 'Music')!;
    for (const collection of ['albums', 'songs'] as const) {
      const response = await f.get(
        `/api/v1/${collection}?${randomQuery()}`,
        credential,
      );
      assertEquals(response.status, 200);
      snapshots.set(collection, {
        body: await response.json(),
        etag: response.headers.get('etag')!,
      });
    }
    for (let i = 0; i < 3; i++) {
      const albums = await library.listAlbums({
        sort: 'random',
        offset: 0,
        size: 5,
        folderId: music.id,
      });
      assertEquals([albums.length, new Set(ids(albums)).size], [5, 5]);
      assert(
        albums.every((a) =>
          f.songs.some((s) => s.albumId === a.id && s.libraryId === music.id)
        ),
      );
      for (
        const songs of [
          await library.randomSongs(5, music.id),
          await library.randomSongs({
            size: 5,
            folderId: music.id,
            genre: 'Jazz',
            fromYear: 2000,
            toYear: 2020,
          }),
        ]
      ) {
        assertEquals([songs.length, new Set(ids(songs)).size], [5, 5]);
        assert(songs.every((s) => s.libraryId === music.id));
      }
      const filtered = await library.randomSongs({
        size: 100,
        folderId: music.id,
        genre: 'Jazz',
        fromYear: 2000,
        toYear: 2020,
      });
      assertEquals(filtered.length, 7);
      assert(
        filtered.every((s) =>
          s.genre === 'Jazz' && s.year! >= 2000 && s.year! <= 2020
        ),
      );
      for (const collection of ['albums', 'songs'] as const) {
        assertEquals(
          await read(f, collection, credential),
          snapshots.get(collection)!.body,
        );
      }
    }
    const reopened = await f.reopen();
    for (const use of ['cookie', 'bearer'] as const) {
      const login = await reopened.login(use, 'listener', 'password-listener');
      for (const collection of ['albums', 'songs'] as const) {
        const before = snapshots.get(collection)!;
        assertEquals(
          await read(reopened, collection, login.credential),
          before.body,
        );
        const response = await reopened.get(
          `/api/v1/${collection}?${randomQuery()}`,
          login.credential,
          { 'If-None-Match': before.etag },
        );
        assertEquals(response.status, 304);
        assertEquals(response.headers.get('etag'), before.etag);
        assertEquals(await response.text(), '');
        // Reopen preserves page boundaries too, not just the complete set.
        const page = await read(
          reopened,
          collection,
          login.credential,
          `${randomQuery()}&offset=2&limit=3`,
        );
        const body = before.body as Record<Collection, { id: string }[]>;
        assertEquals(page[collection], body[collection].slice(2, 5));
      }
    }
  } finally {
    await f.close();
  }
});
