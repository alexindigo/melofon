import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createUserService } from '../src/user.ts';
import { scanLibrary } from '../src/scan.ts';
import { rawSql } from '../src/store/testing.ts';

const base = '/api/v1/albums';
const modes = ['starred', 'highest', 'recent', 'frequent'] as const;
type Row = Record<string, unknown> & { id: string; name: string | null };
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function personalFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-personal-albums-' });
  try {
    const f = await apiFixture({
      allLayers: true,
      services: async (f) => {
        const libraries = createLibraries(f.store);
        for (const name of ['Music', 'Second', 'Empty']) {
          await Deno.mkdir(`${root}/${name}`);
          await libraries.add(name, `${root}/${name}`);
        }
        for (
          const [path, album] of [
            ['Music/A/one.mp3', 'Alpha'],
            ['Music/A/two.mp3', 'Alpha'],
            ['Music/B/one.mp3', 'élan'],
            ['Second/C/one.mp3', 'ELAN'],
            ['Second/D/one.mp3', 'Zulu'],
            ['Music/Loose/one.mp3', null],
          ] as const
        ) {
          await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`, {
            recursive: true,
          });
          await tagged(`${root}/${path}`, {
            TIT2: path,
            ...(album === null ? {} : { TALB: album }),
            TPE1: 'Artist',
            TPE2: 'Artist',
            TCON: 'Jazz',
            TDRC: '2000',
          });
        }
        await scanLibrary(f.store);
        return {
          libraries,
          library: createLibrary(f.store),
          annotation: createAnnotation(f.store),
          listens: createListens(f.store),
          user: createUserService(f.store, f.cfg),
        };
      },
    });
    const users: { id: string; username: string }[] = [];
    for (const username of ['alice', 'bob']) {
      users.push(
        await f.auth.users.create(f.admin.id, {
          username,
          password: `password-${username}`,
          role: 'user',
        }),
      );
    }
    const library = createLibrary(f.store);
    const albums = await library.listAlbums({
      sort: 'name',
      size: 100,
      offset: 0,
    });
    const a = albums.find((row) => row.name === 'Alpha')!;
    const b = albums.find((row) => row.name === 'élan')!;
    const c = albums.find((row) => row.name === 'ELAN')!;
    const d = albums.find((row) => row.name === 'Zulu')!;
    const loose = albums.find((row) => row.name === null)!;
    assertEquals(albums.length, 5);
    const songs = await library.listSongs({ offset: 0, size: 100 });
    const song = (albumId: string) =>
      songs.find((row) => row.albumId === albumId)!;
    const libraries = await f.store.catalog.listLibraries();
    const annotation = createAnnotation(f.store);
    const listens = createListens(f.store);
    const star = async (
      username: string,
      albumId: string,
      atMs: number,
      action = 'star',
    ) => {
      const userId = users.find((user) => user.username === username)!.id;
      // Deterministic imported history through the permitted store test seam.
      await rawSql(f.store).run(`INSERT INTO star_events
        (user_id, target_id, target_type, action, occurred_at)
        VALUES (${sql(userId)}, ${sql(albumId)}, 'album', ${
        sql(action)
      }, epoch_ms(${atMs}))`);
    };
    const play = (username: string, albumId: string, playedAtMs: number) =>
      listens.record(username, song(albumId).id, {
        source: 'test',
        playedAtMs,
      });
    await star('alice', a.id, 1000);
    await star('alice', b.id, 2000);
    await star('alice', c.id, 3000);
    await star('bob', d.id, 4000);
    for (const [id, rating] of [[a.id, 5], [b.id, 3], [c.id, 3]] as const) {
      await annotation.setRating('alice', id, rating);
    }
    await annotation.setRating('bob', d.id, 5);
    for (const time of [1000, 2000, 3000]) await play('alice', a.id, time);
    await play('alice', b.id, 5000);
    await play('alice', c.id, 4000);
    await play('bob', d.id, 6000);
    return {
      ...f,
      root,
      a,
      b,
      c,
      d,
      loose,
      library,
      annotation,
      listens,
      star,
      play,
      song,
      music: libraries.find((row) => row.name === 'Music')!.id,
      second: libraries.find((row) => row.name === 'Second')!.id,
      empty: libraries.find((row) => row.name === 'Empty')!.id,
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

type Fixture = Awaited<ReturnType<typeof personalFixture>>;
async function read(
  f: Fixture,
  credential: string,
  query: string,
  condition = '*',
) {
  const response = await f.get(`${base}?${query}`, credential, {
    Origin: 'http://foreign.home',
    'If-None-Match': condition,
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get('cache-control'), 'private, no-store');
  assertEquals(response.headers.get('etag'), null);
  return await response.json() as {
    albums: Row[];
    total: number;
    offset: number;
    limit: number;
  };
}

Deno.test('API personal albums: two users select different bounded lists with unchanged unannotated rows', async () => {
  const f = await personalFixture();
  try {
    const tied = [f.b, f.c].sort((a, b) => a.id < b.id ? -1 : 1);
    const expected = {
      starred: [f.c, f.b, f.a],
      highest: [f.a, ...tied],
      recent: [f.b, f.c, f.a],
      frequent: [f.a, ...tied],
    };
    for (const use of ['cookie', 'bearer'] as const) {
      const alice = await f.login(use, 'alice', 'password-alice');
      const bob = await f.login(use, 'bob', 'password-bob');
      const commonResponse = await f.get(base, alice.credential);
      const common = await commonResponse.json() as { albums: Row[] };
      for (const mode of modes) {
        const all = await read(f, alice.credential, `sort=${mode}`);
        assertEquals(Object.keys(all).sort(), [
          'albums',
          'limit',
          'offset',
          'total',
        ]);
        assertEquals(ids(all.albums), ids(expected[mode]));
        assertEquals(all.total, 3);
        assertEquals(all.offset, 0);
        assertEquals(all.limit, 50);
        const pages = [];
        for (const offset of [0, 1, 2, 3, 99]) {
          const page = await read(
            f,
            alice.credential,
            `sort=${mode}&offset=${offset}&limit=1`,
          );
          assertEquals(page.total, 3);
          assertEquals(page.offset, offset);
          assertEquals(page.limit, 1);
          assertEquals(
            ids(page.albums),
            ids(expected[mode].slice(offset, offset + 1)),
          );
          pages.push(...page.albums);
        }
        assertEquals(pages, all.albums);
        const other = await read(f, bob.credential, `sort=${mode}`);
        assertEquals(ids(other.albums), [f.d.id]);
        assertEquals(other.total, 1);
        for (const row of [...all.albums, ...other.albums]) {
          assertEquals(row, common.albums.find((item) => item.id === row.id));
          const detail =
            await (await f.get(`${base}/${row.id}`, alice.credential)).json();
          const { songs: _songs, ...summary } = detail.album;
          assertEquals(row, summary);
          for (
            const key of [
              'starred',
              'userRating',
              'averageRating',
              'playCount',
              'played',
              'lastPlayed',
              'path',
              'libraryPath',
            ]
          ) {
            assert(!(key in row), key);
          }
        }
      }
    }
    assert(f.peers.every((peer) => peer !== '127.0.0.1' && peer !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API personal albums: library and genre/year eligibility compose before exact totals and paging', async () => {
  const f = await personalFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(use, 'alice', 'password-alice');
      for (const mode of modes) {
        const music = await read(
          f,
          credential,
          `sort=${mode}&library=${f.music}&genre=Jazz&fromYear=2000&toYear=2000&limit=1&offset=9`,
        );
        assertEquals(music.albums, []);
        assertEquals(music.total, 2);
        const second = await read(
          f,
          credential,
          `sort=${mode}&library=${f.second}`,
        );
        assertEquals(ids(second.albums), [f.c.id]);
        assertEquals(second.total, 1);
        const none = await read(
          f,
          credential,
          `sort=${mode}&library=${f.empty}&offset=10`,
        );
        assertEquals(none.total, 0);
        assertEquals(none.albums, []);
        assertEquals(
          (await read(f, credential, `sort=${mode}&genre=absent`)).total,
          0,
        );
        assertEquals(
          (await read(f, credential, `sort=${mode}&fromYear=2001`)).total,
          0,
        );
        const all = await read(
          f,
          credential,
          `sort=${mode}&library=${f.music}`,
        );
        const alpha = all.albums.find((row) => row.id === f.a.id)!;
        assertEquals(alpha.songCount, 2);
        assertEquals(alpha.durationMs, f.a.durationMs);
      }
    }
  } finally {
    await f.close();
  }
});

Deno.test('API personal albums: history changes are immediately visible despite catalog conditional headers', async () => {
  for (const use of ['cookie', 'bearer'] as const) {
    const f = await personalFixture();
    try {
      const { credential } = await f.login(use, 'alice', 'password-alice');
      const common = await f.get(base, credential);
      const tag = common.headers.get('etag')!;
      await common.json();
      await f.annotation.unstar('alice', f.a.id);
      assertEquals(
        ids((await read(f, credential, 'sort=starred', tag)).albums),
        [f.c.id, f.b.id],
      );
      await f.annotation.star('alice', f.a.id);
      assertEquals(
        ids((await read(f, credential, 'sort=starred', tag)).albums),
        [f.a.id, f.c.id, f.b.id],
      );
      await f.annotation.setRating('alice', f.a.id, 0);
      assertEquals((await read(f, credential, 'sort=highest', tag)).total, 2);
      await f.annotation.setRating('alice', f.a.id, 5);
      const before = await read(f, credential, 'sort=recent', tag);
      await f.play('alice', f.d.id, 9000);
      const after = await read(f, credential, 'sort=recent', tag);
      assertNotEquals(ids(before.albums), ids(after.albums));
      assertEquals(after.albums[0].id, f.d.id);
      assertEquals(after.total, 4);
      for (const time of [10000, 11000, 12000, 13000]) {
        await f.play('alice', f.d.id, time);
      }
      assertEquals(
        (await read(f, credential, 'sort=frequent', tag)).albums[0].id,
        f.d.id,
      );
      const unchanged = await f.get(base, credential, { 'If-None-Match': tag });
      assertEquals(unchanged.status, 304);
      assertEquals(await unchanged.text(), '');
    } finally {
      await f.close();
    }
  }
});

Deno.test('API personal albums: strict native auth/query rules and empty caller selections', async () => {
  const f = await personalFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(use, 'alice', 'password-alice');
      const admin = await f.login(use);
      for (const mode of modes) {
        const empty = await read(f, admin.credential, `sort=${mode}&offset=99`);
        assertEquals(empty.total, 0);
        assertEquals(empty.albums, []);
        await error(
          await f.get(`${base}?sort=${mode}`),
          401,
          'unauthenticated',
        );
        await error(
          await f.get(`${base}?sort=${mode}&library=missing`, credential, {
            'If-None-Match': '*',
          }),
          404,
          'not_found',
        );
        for (
          const query of [
            `sort=${mode}&username=bob`,
            `sort=${mode}&sort=${mode}`,
            `sort=${mode}&limit=0`,
            `sort=${mode}&seed=x`,
          ]
        ) {
          await error(
            await f.get(`${base}?${query}`, credential),
            400,
            'invalid_field',
          );
        }
        await error(
          await f.get(`/api/v1/songs?sort=${mode}`, credential),
          400,
          'invalid_field',
        );
      }
      await error(
        await f.get(`${base}?sort=starred`, credential, {
          Authorization: 'Bearer invalid',
          Cookie: credential,
        }),
        401,
        'unauthenticated',
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('Personal starred albums: sequence membership, millisecond/date ties, orphans and unchanged OpenSubsonic enrichment', async () => {
  const f = await personalFixture();
  try {
    // Latest action is by seq, order is max star timestamp, not latest seq/time.
    await f.star('alice', f.a.id, 9000);
    await f.star('alice', f.a.id, 10000, 'unstar');
    await f.star('alice', f.a.id, 500);
    await f.star('alice', f.b.id, 9000);
    await f.star('alice', f.c.id, 20000, 'unstar');
    await f.star('alice', 'orphan-album', 30000);
    const ordered = [f.a, f.b].sort((a, b) => a.id < b.id ? -1 : 1);
    // Sub-millisecond differences must remain ties, as in the old hat's dates.
    for (const [index, row] of ordered.entries()) {
      await rawSql(f.store).run(`UPDATE star_events SET occurred_at =
        epoch_ms(9000) + INTERVAL ${index === 0 ? 1 : 999} MICROSECOND
        WHERE target_id = ${sql(row.id)} AND action = 'star'
          AND epoch_ms(occurred_at) = 9000`);
    }
    for (const use of ['cookie', 'bearer'] as const) {
      const { credential } = await f.login(use, 'alice', 'password-alice');
      const native = await read(f, credential, 'sort=starred');
      assertEquals(ids(native.albums), ids(ordered));
      assertEquals(native.total, 2);
      for (const op of ['getAlbumList', 'getAlbumList2']) {
        const key = op === 'getAlbumList' ? 'albumList' : 'albumList2';
        const rest = async (extra = '') => {
          const response = await f.get(
            `/rest/${op}?u=alice&p=password-alice&v=1.16.1&c=a09&f=json&type=starred${extra}`,
          );
          assertEquals(response.status, 200);
          const body = (await response.json())['subsonic-response'];
          assertEquals(body.status, 'ok');
          return body[key].album as Row[];
        };
        const rows = await rest();
        assertEquals(ids(rows), ids(ordered));
        assertEquals(ids(await rest('&offset=1&size=1')), [ordered[1].id]);
        assertEquals(await rest('&offset=9'), []);
        assertEquals(await rest('&size=0'), []);
        assertEquals(await rest('&musicFolderId=missing'), []);
        const alpha = rows.find((row) => row.id === f.a.id)!;
        assertEquals(alpha.starred, new Date(9000).toISOString());
        assertEquals(alpha.userRating, 5);
        assertEquals(alpha.averageRating, 5);
        assertEquals(alpha.playCount, 3);
        assertEquals(alpha.played, new Date(3000).toISOString());
      }
    }
    // A real source removal retains history, but neither selection lists or counts it.
    await createLibraries(f.store).remove(f.music);
    const { credential } = await f.login('bearer', 'alice', 'password-alice');
    assertEquals((await read(f, credential, 'sort=starred')).total, 0);
    assert(
      (await f.store.annotations.facts('alice', [f.a.id]))[f.a.id].starred,
    );
  } finally {
    await f.close();
  }
});
