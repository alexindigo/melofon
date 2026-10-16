// H2 catalog contracts through the real DB, facade and protocol consumers.
// Fixed catalog rows are independent oracles, never computed by Library queries.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { encryptPassword, seedFirstUser } from '../src/users.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createUserService } from '../src/user.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const id = (n: number) => n.toString(16).padStart(8, '0') + '0'.repeat(24);
const sql = (s: string) => `'${s.replaceAll("'", "''")}'`;
// [source, genre, year, album]. Both bounds, NULL, video and albumless cases.
const ROWS = [
  [0, 'Jazz', 2000, 0],
  [0, 'Jazz', 2005, 1],
  [0, 'Jazz', 2010, null],
  [0, 'Jazz', null, 0],
  [0, 'Rock', 2005, 1],
  [1, 'Jazz', 2005, 2],
  [1, 'Jazz', 1999, 2],
  [1, 'Rock', 2011, 3],
] as const;
type Envelope = Record<string, unknown> & { status: string };
type Item = { id: string; year?: number; genre?: string; isVideo?: boolean };

async function setup(large = false) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-selection-' });
  const store = await openStore(dir);
  const db = store;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'alice',
    password: 'test',
    secret: 'fixture',
    version: 'test',
  };
  await seedFirstUser(store, cfg);
  await rawSql(db).run(
    `INSERT INTO users VALUES ('bob-id', 'bob', ${
      sql(await encryptPassword(cfg.secret, 'test'))
    }, now())`,
  );
  const libraries = createLibraries(store);
  const sources = [];
  for (const name of ['A', 'B']) {
    const path = `${dir}/${name}`;
    await Deno.mkdir(path);
    sources.push(await libraries.add(name, path));
  }
  // Insert deliberately reverse-ID order with equal labels: ordering must not
  // accidentally rely on insertion/physical row order.
  await rawSql(db).run(
    `INSERT INTO artists VALUES (${sql(id(12))}, 'Same'), (${
      sql(id(11))
    }, 'Same')`,
  );
  for (let n = 3; n >= 0; n--) {
    await rawSql(db).run(
      `INSERT INTO albums VALUES (${sql(id(20 + n))}, 'Same', ${
        sql(id(11 + n % 2))
      })`,
    );
  }
  for (let n = ROWS.length - 1; n >= 0; n--) {
    const [source, genre, year, album] = ROWS[n];
    const path = `${sources[source].path}/${n}.mp3`;
    await Deno.copyFile(
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3',
      path,
    );
    await rawSql(db).run(
      `INSERT INTO files (id,path,library_id,title,album_id,artist_id,genre,year,is_video,mtime,duration_ms)
      VALUES (${sql(id(100 + n))},${sql(path)},${
        sql(sources[source].id)
      },'Same',${album === null ? 'NULL' : sql(id(20 + album))},${
        sql(id(11 + source))
      },${sql(genre)},${year ?? 'NULL'},${n === 2},1000,1000)`,
    );
  }
  if (large) {
    // Separate 501-album/501-song eligible pool. Fixed IDs and identical label,
    // source/year/genre/mTime; tests can independently enumerate its exact set.
    await rawSql(db).run(
      `INSERT INTO artists SELECT lpad(lower(to_hex(3000+i)),8,'0') || repeat('0',24), 'Bulk' FROM range(501) r(i)`,
    );
    await rawSql(db).run(
      `INSERT INTO albums SELECT lpad(lower(to_hex(1000+i)),8,'0') || repeat('0',24), 'Bulk', lpad(lower(to_hex(3000+i)),8,'0') || repeat('0',24) FROM range(501) r(i)`,
    );
    await rawSql(db).run(
      `INSERT INTO files (id,path,library_id,title,album_id,artist_id,genre,year,mtime,duration_ms)
      SELECT lpad(lower(to_hex(2000+i)),8,'0') || repeat('0',24), ${
        sql(sources[1].path + '/bulk-')
      } || i || '.mp3', ${
        sql(sources[1].id)
      }, 'Bulk', lpad(lower(to_hex(1000+i)),8,'0') || repeat('0',24), ${
        sql(id(11))
      }, 'Bulk', 2005, 1000, 1000 FROM range(501) r(i)`,
    );
    await rawSql(db).run(
      `INSERT INTO star_events (user_id, target_id, target_type, action, occurred_at) SELECT u.id, al.id, 'album', 'star', now() FROM users u CROSS JOIN albums al WHERE al.name='Bulk'`,
    );
    await rawSql(db).run(
      `INSERT INTO ratings SELECT u.id, al.id, 5 FROM users u CROSS JOIN albums al WHERE al.name='Bulk'`,
    );
    await rawSql(db).run(
      `INSERT INTO listens SELECT u.id, f.id, now(), 1000, 'fixture' FROM users u CROSS JOIN files f WHERE f.genre='Bulk'`,
    );
  }
  const library = createLibrary(store);
  const bag = {
    cfg,
    libraries,
    library,
    user: createUserService(store, cfg),
    annotation: createAnnotation(store),
    listens: createListens(store),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const layers = await loadLayers({ app: bag });
  const app = facade(core, layers);
  const own = facade(core, layers, {
    listenPort: 3689,
    defaultPort: 4534,
    env: {},
  });
  const request = async (
    op: string,
    extra: Record<string, string> = {},
    method = 'GET',
    format = 'json',
    username = 'alice',
  ) => {
    const p = new URLSearchParams({
      u: username,
      p: 'test',
      v: '1.16.1',
      c: 'H2',
      f: format,
      ...extra,
    });
    return await app(
      new Request(
        `http://x/rest/${op}${method === 'GET' ? '?' + p : ''}`,
        method === 'POST' ? { method, body: p } : {},
      ),
    );
  };
  const get = async (
    op: string,
    extra: Record<string, string> = {},
    username = 'alice',
  ): Promise<Envelope> => {
    const res = await request(op, extra, 'GET', 'json', username);
    assertEquals(res.status, 200);
    return (await res.json())['subsonic-response'];
  };
  return {
    db,
    library,
    sources,
    request,
    get,
    own,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function items(body: Envelope, key: string, kind = 'song'): Item[] {
  assertEquals(body.status, 'ok');
  return (body[key] as Record<string, Item[]>)[kind];
}
const ids = (rows: Item[]) => rows.map((r) => r.id);

Deno.test('H2 behavioral red: present empty query enumerates real REST rows', async () => {
  const s = await setup();
  try {
    const result = await s.get('search3', {
      query: '',
      artistCount: '0',
      albumCount: '0',
    });
    assertEquals(result.status, 'ok');
    assertEquals(
      ids(items(result, 'searchResult3')),
      [100, 101, 102, 103, 104, 105, 106, 107].map(id),
    );
  } finally {
    await s.close();
  }
});

Deno.test('H2 behavioral red: exhaustive random pool obeys genre year source conjunction', async () => {
  const s = await setup();
  try {
    const songs = items(
      await s.get('getRandomSongs', {
        size: '99',
        genre: 'Jazz',
        fromYear: '2000',
        toYear: '2005',
        musicFolderId: s.sources[0].id,
      }),
      'randomSongs',
    );
    assertEquals(ids(songs).sort(), [id(100), id(101)]);
    assert(
      songs.every((song) =>
        song.genre === 'Jazz' && song.year !== undefined && song.year >= 2000 &&
        song.year <= 2005
      ),
    );
  } finally {
    await s.close();
  }
});

Deno.test('H2 GET/form/plain/view JSON/XML empty query and missing-query contracts', async () => {
  const s = await setup();
  try {
    for (const op of ['search3', 'search3.view']) {
      for (const method of ['GET', 'POST']) {
        for (const format of ['json', 'xml']) {
          const res = await s.request(
            op,
            {
              query: '',
              artistCount: '0',
              albumCount: '0',
              songCount: '2',
              songOffset: '1',
            },
            method,
            format,
          );
          const text = await res.text();
          if (format === 'json') {
            assertEquals(
              ids(
                items(JSON.parse(text)['subsonic-response'], 'searchResult3'),
              ),
              [id(101), id(102)],
            );
          } else {
            assert(text.includes('status="ok"'));
            assertEquals(
              [...text.matchAll(/<song id="([^"]+)"/g)].map((m) => m[1]),
              [id(101), id(102)],
            );
            assert(!text.includes('<artist ') && !text.includes('<album '));
          }
          const missing = await s.request(op, {}, method, format);
          const failed = await missing.text();
          assert(
            format === 'json'
              ? JSON.parse(failed)['subsonic-response'].error.code === 10
              : failed.includes('<error code="10"'),
          );
        }
      }
    }
    assertEquals((await s.get('search2', { query: '' })).status, 'failed');
    assertEquals(
      (await s.get('getSongsByGenre', { genre: '' })).status,
      'failed',
    );
  } finally {
    await s.close();
  }
});

Deno.test('H2 stable independent pages join duplicate-label groups without gaps or repetition', async () => {
  const s = await setup();
  try {
    const oracles = {
      artist: [id(11), id(12)],
      album: [20, 21, 22, 23].map(id),
      song: [100, 101, 102, 103, 104, 105, 106, 107].map(id),
    };
    for (const kind of ['artist', 'album', 'song'] as const) {
      const seen: string[] = [];
      for (let offset = 0; offset <= oracles[kind].length; offset++) {
        const body = await s.get('search3', {
          query: '',
          artistCount: '0',
          albumCount: '0',
          songCount: '0',
          [`${kind}Count`]: '1',
          [`${kind}Offset`]: String(offset),
        });
        const group = items(body, 'searchResult3', kind);
        assertEquals(ids(group), oracles[kind].slice(offset, offset + 1));
        seen.push(...ids(group));
        for (const other of ['artist', 'album', 'song']) {
          if (other !== kind) {
            assertEquals(items(body, 'searchResult3', other), []);
          }
        }
      }
      assertEquals(seen, oracles[kind]);
      assertEquals(new Set(seen).size, seen.length);
    }
    for (const username of ['alice', 'bob']) {
      for (const folder of [s.sources[0].id, s.sources[1].id]) {
        const body = await s.get('search3', {
          query: '',
          musicFolderId: folder,
        }, username);
        assertEquals(
          ids(items(body, 'searchResult3')),
          folder === s.sources[0].id
            ? [100, 101, 102, 103, 104].map(id)
            : [105, 106, 107].map(id),
        );
      }
    }
    assertEquals(
      ids(
        items(
          await s.get('search3', { query: '', musicFolderId: '2147483647' }),
          'searchResult3',
        ),
      ),
      [],
    );
  } finally {
    await s.close();
  }
});

Deno.test('H2 exhaustive random predicates handle independent bounds NULL reversed and empty pools', async () => {
  const s = await setup();
  try {
    const cases: [Record<string, string>, number[]][] = [
      [{}, [100, 101, 102, 103, 104, 105, 106, 107]],
      [{ genre: 'Jazz' }, [100, 101, 102, 103, 105, 106]],
      [{ fromYear: '2005' }, [101, 102, 104, 105, 107]],
      [{ toYear: '2000' }, [100, 106]],
      [{ fromYear: '2005', toYear: '2005' }, [101, 104, 105]],
      [{ fromYear: '2010', toYear: '2000' }, []],
      [{ genre: 'jazz' }, []],
      [{ genre: "Jazz' OR 1=1 --" }, []],
      [{
        genre: 'Jazz',
        fromYear: '2000',
        toYear: '2010',
        musicFolderId: s.sources[0].id,
      }, [100, 101, 102]],
      [{ musicFolderId: '2147483647' }, []],
    ];
    const folders = await s.get('getMusicFolders');
    const wire =
      (folders.musicFolders as { musicFolder: { name: string; id: number }[] })
        .musicFolder.find((f) => f.name === 'B')!.id;
    cases.push([{
      genre: 'Jazz',
      musicFolderId: String(wire),
      fromYear: '2005',
    }, [105]]);
    for (const [params, expected] of cases) {
      const songs = items(
        await s.get('getRandomSongs', { size: '99', ...params }),
        'randomSongs',
      );
      assertEquals(ids(songs).sort(), expected.map(id));
      assertEquals(new Set(ids(songs)).size, songs.length);
    }
    const video = items(
      await s.get('getRandomSongs', {
        size: '99',
        genre: 'Jazz',
        fromYear: '2010',
        toYear: '2010',
      }),
      'randomSongs',
    );
    assertEquals(ids(video), [id(102)]);
    assertEquals(video[0].isVideo, true);
    assertEquals(
      ids(
        items(
          await s.get('getSongsByGenre', {
            genre: 'Jazz',
            count: '99',
            musicFolderId: s.sources[0].id,
          }),
          'songsByGenre',
        ),
      ),
      [100, 101, 102, 103].map(id),
    );
    assertEquals(
      ids(
        items(
          await s.get('getSongsByGenre', {
            genre: 'Jazz',
            offset: '2',
            count: '2',
          }),
          'songsByGenre',
        ),
      ),
      [id(102), id(103)],
    );
  } finally {
    await s.close();
  }
});

Deno.test('H2 supplied malformed/unsafe years fail rather than broaden random or album selection', async () => {
  const s = await setup();
  try {
    for (
      const raw of [
        '',
        ' ',
        'NaN',
        'Infinity',
        '2000x',
        '2000.5',
        '9007199254740992',
      ]
    ) {
      for (const bound of ['fromYear', 'toYear']) {
        const random = await s.get('getRandomSongs', { [bound]: raw });
        assertEquals((random.error as { code: number }).code, 10);
        for (const op of ['getAlbumList', 'getAlbumList2']) {
          const album = await s.get(op, {
            type: 'byYear',
            fromYear: '2000',
            toYear: '2010',
            [bound]: raw,
          });
          assertEquals((album.error as { code: number }).code, 10);
        }
      }
    }
    const reverse = items(
      await s.get('getAlbumList2', {
        type: 'byYear',
        fromYear: '2011',
        toYear: '1999',
      }),
      'albumList2',
      'album',
    );
    assertEquals(ids(reverse), [23, 21, 22, 20].map(id));
  } finally {
    await s.close();
  }
});

Deno.test('H2 501-eligible pools prove wire500/default/zero caps for random genre and every album sort', async () => {
  const s = await setup(true);
  try {
    for (
      const value of [
        '0',
        '10',
        '501',
        '9007199254740991',
        '9007199254740992',
        'Infinity',
        'NaN',
        '-1',
        '2.5',
      ]
    ) {
      const count = value === '0'
        ? 0
        : ['501', '9007199254740991'].includes(value)
        ? 500
        : 10;
      const songs = items(
        await s.get('getRandomSongs', { genre: 'Bulk', size: value }),
        'randomSongs',
      );
      assertEquals(songs.length, count);
      assertEquals(new Set(ids(songs)).size, count);
      const eligible = new Set(
        Array.from({ length: 501 }, (_, n) => id(2000 + n)),
      );
      assert(songs.every((song) => eligible.has(song.id)));
      const genre = items(
        await s.get('getSongsByGenre', { genre: 'Bulk', count: value }),
        'songsByGenre',
      );
      assertEquals(
        ids(genre),
        Array.from({ length: count }, (_, n) => id(2000 + n)),
      );
      for (const op of ['getAlbumList', 'getAlbumList2']) {
        const albums = items(
          await s.get(op, { type: 'byGenre', genre: 'Bulk', size: value }),
          op === 'getAlbumList' ? 'albumList' : 'albumList2',
          'album',
        );
        assertEquals(
          ids(albums),
          Array.from({ length: count }, (_, n) => id(1000 + n)),
        );
      }
    }
    assertEquals(
      items(await s.get('getRandomSongs', { genre: 'Bulk' }), 'randomSongs')
        .length,
      10,
    );
    assertEquals(
      items(await s.get('getSongsByGenre', { genre: 'Bulk' }), 'songsByGenre')
        .length,
      10,
    );
    for (const op of ['getAlbumList', 'getAlbumList2']) {
      const key = op === 'getAlbumList' ? 'albumList' : 'albumList2';
      assertEquals(
        items(await s.get(op, { type: 'byGenre', genre: 'Bulk' }), key, 'album')
          .length,
        10,
      );
      for (
        const type of [
          'random',
          'newest',
          'highest',
          'frequent',
          'recent',
          'alphabeticalByName',
          'alphabeticalByArtist',
          'starred',
          'byYear',
          'byGenre',
        ]
      ) {
        const albums = items(
          await s.get(op, {
            type,
            genre: 'Bulk',
            fromYear: '2005',
            toYear: '2005',
            size: '501',
          }, 'bob'),
          key,
          'album',
        );
        assertEquals(albums.length, 500);
        assertEquals(new Set(ids(albums)).size, 500);
      }
    }
  } finally {
    await s.close();
  }
});

Deno.test('H2 safe independent search counts/offsets without search500/core/OwnTone truncation', async () => {
  const s = await setup(true);
  try {
    for (const kind of ['artist', 'album', 'song']) {
      for (const raw of ['9007199254740992', 'Infinity', 'NaN', '-1', '1.5']) {
        const body = await s.get('search3', {
          query: 'Bulk',
          artistCount: '0',
          albumCount: '0',
          songCount: '0',
          [`${kind}Count`]: raw,
          [`${kind}Offset`]: raw,
        });
        const rows = items(body, 'searchResult3', kind);
        assertEquals(
          ids(rows),
          Array.from({ length: 20 }, (_, n) =>
            id(
              ({ artist: 3000, album: 1000, song: 2000 } as Record<
                string,
                number
              >)[kind] + n,
            )),
        );
      }
    }
    const all = await s.get('search3', {
      query: 'Bulk',
      artistCount: '9007199254740991',
      albumCount: '9007199254740991',
      songCount: '9007199254740991',
    });
    for (const kind of ['artist', 'album', 'song']) {
      assertEquals(items(all, 'searchResult3', kind).length, 501);
    }
    const core = await s.library.search3('', {
      artistCount: Number.MAX_SAFE_INTEGER,
      artistOffset: 0,
      albumCount: Number.MAX_SAFE_INTEGER,
      albumOffset: 0,
      songCount: Number.MAX_SAFE_INTEGER,
      songOffset: 0,
    });
    assertEquals(core.artists.length, 503);
    assertEquals(core.albums.length, 505);
    assertEquals(core.songs.length, 509);
    assertEquals((await s.library.randomSongs(1000)).length, 509);
    assertEquals(
      (await s.library.songsByGenre('Bulk', {
        size: Number.MAX_SAFE_INTEGER,
        offset: 0,
      })).length,
      501,
    );
    const response = await s.own(
      new Request('http://x/api/library/albums?offset=500&limit=1'),
    );
    assertEquals(response.status, 200);
    const own = await response.json();
    assertEquals(own.total, 505);
    assertEquals(own.items.length, 1);
    assertEquals(
      own.items[0].id,
      String(Number(BigInt('0x' + id(1500).slice(0, 8)) & 0x7fffffffn)),
    );
    for (const raw of ['9007199254740992', 'Infinity', '-1', '1.5']) {
      assertEquals(
        ids(
          items(
            await s.get('getSongsByGenre', {
              genre: 'Bulk',
              count: '1',
              offset: raw,
            }),
            'songsByGenre',
          ),
        ),
        [id(2000)],
      );
      assertEquals(
        ids(
          items(
            await s.get('getAlbumList2', {
              type: 'byGenre',
              genre: 'Bulk',
              size: '1',
              offset: raw,
            }),
            'albumList2',
            'album',
          ),
        ),
        [id(1000)],
      );
    }
  } finally {
    await s.close();
  }
});
