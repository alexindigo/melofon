import { assert, assertEquals, assertRejects } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';
import { tagged } from './helpers/tagged.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { scanLibrary } from '../src/scan.ts';
import { createReference, type ReferenceProvider } from '../src/reference.ts';
import { createListens } from '../src/listens.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createUserService } from '../src/user.ts';
import { rawSql } from '../src/store/testing.ts';

async function radioFixture() {
  const root = await Deno.makeTempDir({ prefix: 'melofon-api-radio-' });
  let reference: ReturnType<typeof createReference>;
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
          const [path, title, album, artist, genre] of [
            ['Music/A/seed', 'Seed', 'A', 'Main', 'Rock'],
            ['Music/A/a', 'Alpha', 'A', 'Main', 'Rock'],
            ['Music/B/b', 'Beta', 'B', 'Main', 'Jazz'],
            ['Music/Near/n', 'Near song', 'Near', 'Near', 'Rock'],
            ['Second/C/c', 'Second song', 'C', 'Main', 'Rock'],
            ['Second/Far/f', 'Far song', 'Far', 'Far', 'Rock'],
            ['Music/Unknown/u', '', '', '', ''],
            ['Music/Various/x', 'One song', 'Various', 'One', ''],
            ['Music/Various/y', 'Two song', 'Various', 'Two', ''],
          ]
        ) {
          await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf('/'))}`, {
            recursive: true,
          });
          await tagged(`${root}/${path}.mp3`, {
            ...(title ? { TIT2: title } : {}),
            ...(album ? { TALB: album } : {}),
            ...(artist ? { TPE1: artist } : {}),
            ...(genre ? { TCON: genre } : {}),
          });
        }
        await scanLibrary(f.store);
        const artist: ReferenceProvider = {
          plugin: 'fixture',
          capability: {
            id: 'artist',
            accepts: 'artist',
            provides: ['artist.similar', 'artist.topTracks'],
            requires: [],
          },
        };
        const track: ReferenceProvider = {
          plugin: 'fixture',
          capability: {
            id: 'track',
            accepts: 'track',
            provides: ['track.similar'],
            requires: [],
          },
        };
        reference = createReference({
          store: f.store,
          state: f.state,
          providers: (type) =>
            Promise.resolve([type === 'artist' ? artist : track]),
          enqueue: () => Promise.resolve(),
          random: () => 0.6,
        });
        return {
          libraries,
          reference,
          library: createLibrary(f.store),
          annotation: createAnnotation(f.store),
          listens: createListens(f.store),
          user: createUserService(f.store, f.cfg),
        };
      },
    });
    for (const username of ['alice', 'bob']) {
      await f.auth.users.create(f.admin.id, {
        username,
        password: `password-${username}`,
        role: 'user',
      });
    }
    const songs = await f.store.catalog.listSongs({ offset: 0, size: 100 });
    const song = (file: string) =>
      songs.find((s) => s.path.endsWith(`/${file}.mp3`))!;
    const libraries = await f.store.catalog.listLibraries();
    return {
      ...f,
      root,
      reference: reference!,
      songs,
      song,
      music: libraries.find((l) => l.name === 'Music')!.id,
      second: libraries.find((l) => l.name === 'Second')!.id,
      empty: libraries.find((l) => l.name === 'Empty')!.id,
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
type Fixture = Awaited<ReturnType<typeof radioFixture>>;
type Kind = 'songs' | 'albums' | 'artists';
function path(f: Fixture, kind: Kind, id?: string) {
  return `/api/v1/${kind}/${
    id ?? (kind === 'songs'
      ? f.song('seed').id
      : kind === 'albums'
      ? f.song('seed').albumId
      : f.song('seed').artistId)
  }/radio`;
}
const ids = (body: { songs: { id: string }[] }) => body.songs.map((s) => s.id);
async function read(f: Fixture, credential: string, url: string) {
  const response = await f.get(url, credential, {
    Origin: 'http://foreign.home',
    'If-None-Match': '*',
  });
  assertEquals(response.status, 200, await response.clone().text());
  assertEquals(response.headers.get('cache-control'), 'private, no-store');
  assertEquals(response.headers.get('etag'), null);
  const body = await response.json();
  assertEquals(Object.keys(body).sort(), ['limit', 'songs']);
  assertEquals(new Set(ids(body)).size, body.songs.length);
  assert(!JSON.stringify(body).includes(f.root));
  for (const row of body.songs) {
    for (
      const key of [
        'starred',
        'userRating',
        'averageRating',
        'playCount',
        'played',
        'lastPlayed',
      ]
    ) assert(!(key in row));
    const detail = await f.get(`/api/v1/songs/${row.id}`, credential);
    assertEquals(detail.status, 200);
    assertEquals(row, (await detail.json()).song);
  }
  return body;
}
async function similar(f: Fixture, file: string, titles: [string, string][]) {
  await f.reference.record('track', f.song(file).id, 'fixture', [
    'track.similar',
  ], {
    'track.similar': titles.map(([title, artist]) => ({ title, artist })),
  });
}

Deno.test('API radio: song genre pool is scoped before sampling, excludes absent songs and seed, with safe native cookie/Bearer responses', async () => {
  const f = await radioFixture();
  try {
    await rawSql(f.store).run(
      `UPDATE file_identity SET present = false WHERE id = '${f.song('a').id}'`,
    );
    for (const use of ['cookie', 'bearer'] as const) {
      const credential =
        (await f.login(use, 'alice', 'password-alice')).credential;
      assertEquals(
        new Set(ids(await read(f, credential, path(f, 'songs')))),
        new Set(['n', 'c', 'f'].map((s) => f.song(s).id)),
      );
      const url = path(f, 'songs') + `?library=${f.music}`;
      assertEquals(ids(await read(f, credential, url)), [f.song('n').id]);
      assertEquals(ids(await read(f, credential, url + '&limit=1')), [
        f.song('n').id,
      ]);
    }
    assert(f.peers.every((p) => p !== '127.0.0.1' && p !== '::1'));
  } finally {
    await f.close();
  }
});

Deno.test('API radio: provider matching drops missing, absent, out-of-library, seed and duplicate recommendations before limit', async () => {
  const f = await radioFixture();
  try {
    await similar(f, 'seed', [
      ['Second song', 'Main'],
      ['Gone', 'Nobody'],
      ['Seed', 'Main'],
      ['Alpha', 'Main'],
      ['Near song', 'Near'],
      ['Near song', 'Near'],
    ]);
    await rawSql(f.store).run(
      `UPDATE file_identity SET present = false WHERE id = '${f.song('a').id}'`,
    );
    for (const use of ['cookie', 'bearer'] as const) {
      const credential =
        (await f.login(use, 'alice', 'password-alice')).credential;
      assertEquals(
        ids(await read(f, credential, path(f, 'songs') + '?limit=1')),
        [f.song('c').id],
      );
      assertEquals(
        ids(
          await read(
            f,
            credential,
            path(f, 'songs') + `?library=${f.music}&limit=1`,
          ),
        ),
        [f.song('n').id],
      );
      assertEquals(
        new Set(
          ids(await read(f, credential, path(f, 'songs') + '?limit=100')),
        ),
        new Set(['c', 'n'].map((s) => f.song(s).id)),
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('API radio: artist weighted pool uses caller played albums and scopes similar artists and top tracks before count', async () => {
  const f = await radioFixture();
  try {
    const main = f.song('seed').artistId!;
    await f.reference.record('artist', main, 'fixture', ['artist.similar'], {
      'artist.similar': [{ name: 'Far' }, { name: 'Outside' }, {
        name: 'Near',
      }],
    });
    const listens = createListens(f.store);
    for (const file of ['a', 'c', 'n', 'f']) {
      await listens.record('alice', f.song(file).id, { source: 'test' });
    }
    await listens.record('bob', f.song('b').id, { source: 'test' });
    await f.state.set('reference.radioSimilarArtists', '1');
    for (const use of ['cookie', 'bearer'] as const) {
      const alice = (await f.login(use, 'alice', 'password-alice')).credential;
      const bob = (await f.login(use, 'bob', 'password-bob')).credential;
      const url = path(f, 'artists') + `?library=${f.music}`;
      assertEquals(
        new Set(ids(await read(f, alice, url))),
        new Set(['seed', 'a', 'n'].map((s) => f.song(s).id)),
      );
      assertEquals(ids(await read(f, bob, url)), [f.song('b').id]);
      assertEquals((await read(f, alice, url + '&limit=1')).songs.length, 1);
      assertEquals(
        new Set(
          ids(
            await read(f, alice, path(f, 'artists') + `?library=${f.second}`),
          ),
        ),
        new Set(['c', 'f'].map((s) => f.song(s).id)),
      );
    }
    const admin = (await f.login('bearer')).credential;
    assertEquals(ids(await read(f, admin, path(f, 'artists'))), []);
  } finally {
    await f.close();
  }
});

Deno.test('API radio: song artist top-up excludes seed before the top-track cap and uses requesting user history', async () => {
  const f = await radioFixture();
  try {
    await similar(f, 'seed', [['Missing', 'Nobody']]);
    await f.state.set('reference.radioMinTopTracks', '1');
    const listens = createListens(f.store);
    await listens.record('alice', f.song('seed').id, { source: 'test' });
    await listens.record('bob', f.song('c').id, { source: 'test' });
    for (const use of ['cookie', 'bearer'] as const) {
      const alice = (await f.login(use, 'alice', 'password-alice')).credential;
      const bob = (await f.login(use, 'bob', 'password-bob')).credential;
      const url = path(f, 'songs') + `?library=${f.music}&limit=1`;
      assertEquals(ids(await read(f, alice, url)), [f.song('a').id]);
      assertEquals(ids(await read(f, bob, url)), []);
      assertEquals(ids(await read(f, bob, path(f, 'songs') + '?limit=1')), [
        f.song('c').id,
      ]);
    }
  } finally {
    await f.close();
  }
});

Deno.test('API radio: album seeds are admitted before sampling and preserve per-song exclusion and live seed-count settings', async () => {
  const f = await radioFixture();
  try {
    await similar(f, 'seed', [['Second song', 'Main'], ['Seed', 'Main'], [
      'Near song',
      'Near',
    ]]);
    await similar(f, 'a', [['Alpha', 'Main'], ['Beta', 'Main']]);
    for (const use of ['cookie', 'bearer'] as const) {
      const credential =
        (await f.login(use, 'alice', 'password-alice')).credential;
      assertEquals(
        new Set(
          ids(
            await read(
              f,
              credential,
              path(f, 'albums') + `?library=${f.music}`,
            ),
          ),
        ),
        new Set(['n', 'b'].map((s) => f.song(s).id)),
      );
      assertEquals(
        (await read(
          f,
          credential,
          path(f, 'albums') + `?library=${f.music}&limit=1`,
        )).songs.length,
        1,
      );
    }
    await rawSql(f.store).run(
      `UPDATE file_identity SET present = false WHERE id = '${f.song('a').id}'`,
    );
    await f.state.set('reference.radioAlbumSeeds', '1');
    const credential = (await f.login('cookie')).credential;
    assertEquals(
      ids(
        await read(
          f,
          credential,
          path(f, 'albums') + `?library=${f.music}&limit=1`,
        ),
      ),
      [f.song('n').id],
    );
  } finally {
    await f.close();
  }
});

Deno.test('API radio: explicit types disambiguate a shared ID while legacy radio keeps song-first resolution', async () => {
  const f = await radioFixture();
  try {
    const shared = f.song('seed').id;
    const near = f.song('n');
    const q = rawSql(f.store);
    // Deliberate namespace collision through the permitted store test seam.
    await q.run(
      `UPDATE albums SET id = '${shared}' WHERE id = '${near.albumId}'`,
    );
    await q.run(
      `UPDATE files SET album_id = '${shared}' WHERE album_id = '${near.albumId}'`,
    );
    await q.run(
      `UPDATE artists SET id = '${shared}' WHERE id = '${near.artistId}'`,
    );
    await q.run(
      `UPDATE files SET artist_id = '${shared}' WHERE artist_id = '${near.artistId}'`,
    );
    await q.run(
      `UPDATE albums SET album_artist_id = '${shared}' WHERE album_artist_id = '${near.artistId}'`,
    );
    await similar(f, 'seed', [['Alpha', 'Main']]);
    await similar(f, 'n', [['Beta', 'Main']]);
    await f.reference.record(
      'artist',
      shared,
      'fixture',
      ['artist.topTracks'],
      { 'artist.topTracks': [{ title: 'Near song', artist: 'Near' }] },
    );
    for (const use of ['cookie', 'bearer'] as const) {
      const credential =
        (await f.login(use, 'alice', 'password-alice')).credential;
      for (
        const [kind, file] of [['songs', 'a'], ['albums', 'b'], [
          'artists',
          'n',
        ]] as const
      ) {
        assertEquals(ids(await read(f, credential, path(f, kind, shared))), [
          f.song(file).id,
        ]);
      }
    }
    assertEquals(await f.reference.radio(shared, 50, 'alice'), [
      f.song('a').id,
    ]);
    assertEquals(
      await f.reference.radio(shared, 0, 'alice', { type: 'album' }),
      [],
    );
    await assertRejects(
      () => f.reference.radio(shared, -1, 'alice'),
      RangeError,
    );
  } finally {
    await f.close();
  }
});

Deno.test('API radio: unknown, wrong-kind and scoped-out seeds are 404; known empty mixes and placeholders are 200', async () => {
  const f = await radioFixture();
  try {
    for (const use of ['cookie', 'bearer'] as const) {
      const credential =
        (await f.login(use, 'alice', 'password-alice')).credential;
      for (const kind of ['songs', 'albums', 'artists'] as const) {
        for (
          const id of [
            'missing',
            kind === 'songs' ? f.song('seed').albumId! : f.song('seed').id,
          ]
        ) {
          await error(
            await f.get(path(f, kind, id), credential),
            404,
            'not_found',
          );
        }
        await error(
          await f.get(path(f, kind) + `?library=${f.empty}`, credential),
          404,
          'not_found',
        );
        const emptySeed = kind === 'songs'
          ? f.song('u').id
          : kind === 'albums'
          ? f.song('u').albumId!
          : f.song('b').artistId!;
        assertEquals(await read(f, credential, path(f, kind, emptySeed)), {
          songs: [],
          limit: 50,
        });
      }
      for (const id of ['unknown', 'various']) {
        assertEquals(await read(f, credential, path(f, 'artists', id)), {
          songs: [],
          limit: 50,
        });
        await error(
          await f.get(
            path(f, 'artists', id) + `?library=${f.second}`,
            credential,
          ),
          404,
          'not_found',
        );
      }
    }
    await rawSql(f.store).run(
      `UPDATE file_identity SET present = false WHERE id = '${f.song('u').id}'`,
    );
    const credential = (await f.login('bearer')).credential;
    await error(
      await f.get(path(f, 'songs', f.song('u').id), credential),
      404,
      'not_found',
    );
    await error(
      await f.get(path(f, 'albums', f.song('u').albumId!), credential),
      404,
      'not_found',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API radio: strict queries, live shared limits, auth precedence and unchanged OpenSubsonic facade mix contracts', async () => {
  const f = await radioFixture();
  try {
    const cookie =
      (await f.login('cookie', 'alice', 'password-alice')).credential;
    for (const kind of ['songs', 'albums', 'artists'] as const) {
      const url = path(f, kind);
      await error(await f.get(url), 401, 'unauthenticated');
      await error(
        await f.get(url, cookie, { Authorization: 'Bearer invalid' }),
        401,
        'unauthenticated',
      );
      for (
        const query of [
          '?station=1',
          '?seed=1',
          '?offset=1',
          '?limit=0',
          '?limit=-1',
          '?limit=501',
          '?limit=1e2',
          '?limit=9007199254740992',
          '?limit=1&limit=2',
          '?library=',
          '?library=a&library=b',
        ]
      ) {
        await error(await f.get(url + query, cookie), 400, 'invalid_field');
      }
      await error(
        await f.get(url + '?library=missing', cookie),
        404,
        'not_found',
      );
      const response = await f.json(url, 'POST', {}, cookie);
      await error(response, 405, 'method_not_allowed');
      assertEquals(response.headers.get('allow'), 'GET');
    }
    await f.state.set('melofon.browseMaxPageRecords', '1');
    await f.state.set('melofon.browsePageRecords', '2');
    for (const kind of ['songs', 'albums', 'artists'] as const) {
      const body = await read(f, cookie, path(f, kind));
      assertEquals(body.limit, 1);
      assert(body.songs.length <= 1);
      await error(
        await f.get(path(f, kind) + '?limit=2', cookie),
        400,
        'invalid_field',
      );
    }
    for (const operation of ['getSimilarSongs', 'getSimilarSongs2']) {
      const key = operation === 'getSimilarSongs'
        ? 'similarSongs'
        : 'similarSongs2';
      const call = async (id: string, count = '50') => {
        const params = new URLSearchParams({
          u: 'admin',
          p: 'password-admin',
          v: '1.16.1',
          c: 'a19',
          f: 'json',
          id,
          count,
        });
        const response = await f.get(`/rest/${operation}.view?${params}`);
        assertEquals(response.status, 200);
        return (await response.json())['subsonic-response'];
      };
      const result = await call(f.song('seed').id);
      assertEquals(result.status, 'ok');
      assertEquals(
        new Set(result[key].song.map((s: { id: string }) => s.id)),
        new Set(['a', 'n', 'c', 'f'].map((s) => f.song(s).id)),
      );
      assertEquals((await call(f.song('seed').id, '0'))[key].song, []);
      assertEquals((await call('missing')).error.code, 70);
      assertEquals((await call(f.song('seed').artistId!))[key].song, []);
      assert((await call(f.song('seed').albumId!))[key].song.length > 0);
    }
  } finally {
    await f.close();
  }
});
