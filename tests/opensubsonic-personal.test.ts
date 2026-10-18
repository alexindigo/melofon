// tests/opensubsonic-personal.test.ts — H3 personal facts over the real DB and
// facade: stars, ratings, play counts and last-played dates on every song,
// album and artist response; star history (the starred date is the most
// recent like); getStarred next to getStarred2; the musicFolderId filter;
// unknown-ID and rating/scrobble error rules. Data is seeded only through
// HTTP routes; the catalog comes from the fixture library.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { encryptPassword, seedFirstUser } from '../src/users.ts';
import { createScan } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createPlaylists } from '../src/playlists.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { loadLayers } from '../src/layers.ts';
import { createState } from '../src/state.ts';
import { facade } from '../src/facade.ts';

type Envelope = Record<string, unknown> & {
  status: string;
  error?: { code: number; message: string };
};
type Item = Record<string, unknown> & { id: string };
type Params = Record<string, string | string[]>;

const FIXTURE = 'tests/fixtures/library';
// Two explicit, out-of-order scrobble times (the later one is sent first).
const T_LATE = 1700000002000;
const T_EARLY = 1700000001000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function setup(split = false) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-personal-' });
  const store = await openStore(dir);
  const db = store;
  const cfg = {
    listen: undefined,
    dataDir: dir,
    user: 'admin',
    password: 'test',
    secret: 's3cret',
    version: '0.0.0-test',
  };
  await seedFirstUser(store, cfg);
  await rawSql(db).run(
    `INSERT INTO users VALUES ('bob-id', 'bob', ${
      sql(await encryptPassword(cfg.secret, 'test'))
    }, now())`,
  );
  const libraries = createLibraries(store);
  if (split) {
    await libraries.add('A', `${FIXTURE}/Fixture Artist`);
    await libraries.add('B', `${FIXTURE}/Various Artists`);
  } else {
    await libraries.add('Music', FIXTURE);
  }
  const scan = createScan(store);
  await scan.run();
  const library = createLibrary(store);
  const player = createPlayer();
  const nowPlaying = createNowPlaying(store);
  const bag = {
    state: createState(store),
    cfg,
    libraries,
    scan,
    user: createUserService(store, cfg),
    library,
    annotation: createAnnotation(store),
    listens: createListens(store),
    playlists: createPlaylists(store),
    nowPlaying,
    player,
    playback: createPlayback({ player, nowPlaying, library, cfg }),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));

  const rows = (await rawSql(db).all(
    `SELECT f.id, f.title, f.album_id, al.album_artist_id
     FROM files f JOIN albums al ON al.id = f.album_id ORDER BY f.path`,
  )) as {
    id: string;
    title: string;
    album_id: string;
    album_artist_id: string;
  }[];
  const byTitle = (title: string) => {
    const row = rows.find((r) => r.title === title);
    assert(row, `fixture song ${title}`);
    return row;
  };
  const first = byTitle('First Song');
  const theme = byTitle('Theme');
  const ids = {
    first: first.id,
    second: byTitle('Second Song').id,
    theme: theme.id,
    album: first.album_id,
    ost: theme.album_id,
    artist: first.album_artist_id,
    va: theme.album_artist_id,
  };

  const request = async (
    op: string,
    params: Params = {},
    user = 'admin',
    format = 'json',
  ): Promise<Response> => {
    const p = new URLSearchParams({
      u: user,
      p: 'test',
      v: '1.16.1',
      c: 'h3-test',
      f: format,
    });
    for (const [key, value] of Object.entries(params)) {
      for (const v of Array.isArray(value) ? value : [value]) p.append(key, v);
    }
    const res = await app(new Request(`http://x/rest/${op}?${p}`));
    assertEquals(res.status, 200, `${op} HTTP status`);
    return res;
  };
  const get = async (
    op: string,
    params: Params = {},
    user = 'admin',
  ): Promise<Envelope> =>
    (await (await request(op, params, user)).json())['subsonic-response'];
  const okGet = async (
    op: string,
    params: Params = {},
    user = 'admin',
  ): Promise<Envelope> => {
    const body = await get(op, params, user);
    assertEquals(body.status, 'ok', `${op} ${JSON.stringify(body.error)}`);
    return body;
  };
  const xml = async (op: string, params: Params = {}, user = 'admin') =>
    await (await request(op, params, user, 'xml')).text();

  return {
    db,
    libraries,
    scan,
    ids,
    get,
    okGet,
    xml,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function withSetup(fn: (s: Setup) => Promise<void>, split = false) {
  const s = await setup(split);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

function find(list: unknown, id: string, what: string): Item {
  assert(Array.isArray(list), `${what} is a list`);
  const item = (list as Item[]).find((i) => i.id === id);
  assert(item, `${what} contains ${id}`);
  return item;
}

function listOf(container: unknown, key: string): Item[] {
  const list = (container as Record<string, unknown> | undefined)?.[key];
  assert(Array.isArray(list), `${key} is a list`);
  return list as Item[];
}

const idsOf = (list: Item[]) => list.map((i) => i.id);

function isoString(value: unknown, what: string): string {
  assertEquals(typeof value, 'string', `${what} is a string`);
  const text = value as string;
  assertEquals(new Date(text).toISOString(), text, `${what} is ISO`);
  return text;
}

// Attributes of the first `<tag …>` element whose id attribute is `id`.
function xmlAttrs(
  xml: string,
  tag: string,
  id: string,
): Record<string, string> {
  const re = new RegExp(`<${tag}\\s([^>]*?\\bid="${id}"[^>]*?)/?>`);
  const match = re.exec(xml);
  assert(match, `<${tag} id="${id}"> in XML`);
  const attrs: Record<string, string> = {};
  for (const a of match[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
    attrs[a[1]] = a[2];
  }
  return attrs;
}

// The personal fields as XML attribute strings (absent stays absent).
function personalAttrs(item: Item): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (
    const key of [
      'starred',
      'userRating',
      'averageRating',
      'playCount',
      'played',
    ]
  ) {
    out[key] = item[key] === undefined ? undefined : String(item[key]);
  }
  return out;
}

function pickAttrs(
  attrs: Record<string, string>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (
    const key of [
      'starred',
      'userRating',
      'averageRating',
      'playCount',
      'played',
    ]
  ) {
    out[key] = attrs[key];
  }
  return out;
}

// The full song facts expected after case 1's seeding.
function assertSongFacts(item: Item, what: string) {
  isoString(item.starred, `${what} starred`);
  assertEquals(item.userRating, 4, `${what} userRating`);
  assertEquals(item.averageRating, 4, `${what} averageRating`);
  assertEquals(item.playCount, 2, `${what} playCount`);
  assertEquals(item.played, new Date(T_LATE).toISOString(), `${what} played`);
}

// Album facts after case 1: rated 5, starred, both listens are on the album.
function assertAlbumFacts(item: Item, what: string) {
  isoString(item.starred, `${what} starred`);
  assertEquals(item.userRating, 5, `${what} userRating`);
  assertEquals(item.averageRating, 5, `${what} averageRating`);
  assertEquals(item.playCount, 2, `${what} playCount`);
  assertEquals(item.played, new Date(T_LATE).toISOString(), `${what} played`);
}

Deno.test('H3 readback everywhere: song and album facts on every response', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('star', { id: ids.first });
    await s.okGet('star', { albumId: ids.album });
    await s.okGet('setRating', { id: ids.first, rating: '4' });
    await s.okGet('setRating', { id: ids.album, rating: '5' });
    await s.okGet('scrobble', { id: ids.first, time: String(T_LATE) });
    await s.okGet('scrobble', { id: ids.first, time: String(T_EARLY) });

    const song = (await s.okGet('getSong', { id: ids.first })).song as Item;
    assertSongFacts(song, 'getSong');

    const album = (await s.okGet('getAlbum', { id: ids.album })).album as Item;
    assertAlbumFacts(album, 'getAlbum');
    assertSongFacts(
      find(album.song, ids.first, 'getAlbum song'),
      'getAlbum song',
    );

    const list2 = (await s.okGet('getAlbumList2', { type: 'newest' }))
      .albumList2;
    assertAlbumFacts(
      find(listOf(list2, 'album'), ids.album, 'getAlbumList2'),
      'getAlbumList2',
    );
    const list1 = (await s.okGet('getAlbumList', { type: 'newest' }))
      .albumList;
    const v1 = find(listOf(list1, 'album'), ids.album, 'getAlbumList');
    assertAlbumFacts(v1, 'getAlbumList');
    assertEquals(v1.isDir, true);

    const search = (await s.okGet('search3', { query: '' })).searchResult3;
    assertSongFacts(
      find(listOf(search, 'song'), ids.first, 'search3'),
      'search3',
    );
    assertAlbumFacts(
      find(listOf(search, 'album'), ids.album, 'search3'),
      'search3 album',
    );

    const albumDir = (await s.okGet('getMusicDirectory', { id: ids.album }))
      .directory as Item;
    assertAlbumFacts(albumDir, 'album directory');
    assertSongFacts(
      find(albumDir.child, ids.first, 'album directory child'),
      'album directory child',
    );

    const artistDir = (await s.okGet('getMusicDirectory', { id: ids.artist }))
      .directory as Item;
    assertEquals(artistDir.starred, undefined, 'artist not starred yet');
    assertEquals(artistDir.playCount, 2, 'artist directory playCount');
    assertEquals(artistDir.played, new Date(T_LATE).toISOString());
    assertAlbumFacts(
      find(artistDir.child, ids.album, 'artist directory child'),
      'artist directory child',
    );

    await s.okGet('scrobble', { id: ids.first, submission: 'false' });
    const playing = (await s.okGet('getNowPlaying')).nowPlaying;
    assertSongFacts(
      find(listOf(playing, 'entry'), ids.first, 'getNowPlaying'),
      'getNowPlaying',
    );

    const created = (await s.okGet('createPlaylist', {
      name: 'Mix',
      songId: ids.first,
    })).playlist as Item;
    assertSongFacts(
      find(created.entry, ids.first, 'createPlaylist'),
      'createPlaylist',
    );
    const playlist = (await s.okGet('getPlaylist', { id: created.id }))
      .playlist as Item;
    assertSongFacts(
      find(playlist.entry, ids.first, 'getPlaylist'),
      'getPlaylist',
    );

    await s.okGet('star', { artistId: ids.artist });
    const indexes = (await s.okGet('getIndexes')).indexes as {
      index: { artist: Item[] }[];
    };
    const legacy = find(
      indexes.index.flatMap((i) => i.artist),
      ids.artist,
      'getIndexes',
    );
    isoString(legacy.starred, 'getIndexes starred');
    assertEquals(legacy.playCount, undefined, 'legacy Artist has no playCount');
    const artists = (await s.okGet('getArtists')).artists as {
      index: { artist: Item[] }[];
    };
    const id3 = find(
      artists.index.flatMap((i) => i.artist),
      ids.artist,
      'getArtists',
    );
    isoString(id3.starred, 'getArtists starred');
    assertEquals(id3.albumCount, 1);

    const songXml = xmlAttrs(
      await s.xml('getSong', { id: ids.first }),
      'song',
      ids.first,
    );
    assertEquals(pickAttrs(songXml), personalAttrs(song));
    const albumXmlText = await s.xml('getAlbum', { id: ids.album });
    assertEquals(
      pickAttrs(xmlAttrs(albumXmlText, 'album', ids.album)),
      personalAttrs(album),
    );
    assertEquals(
      pickAttrs(xmlAttrs(albumXmlText, 'song', ids.first)),
      personalAttrs(find(album.song, ids.first, 'getAlbum song')),
    );
  });
});

Deno.test('H3 defaults: OpenSubsonic fields are present without data', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    const song = (await s.okGet('getSong', { id: ids.second })).song as Item;
    assertEquals(song.played, '');
    assertEquals(song.starred, undefined);
    assertEquals(song.userRating, undefined);
    assertEquals(song.averageRating, undefined);
    assertEquals(song.playCount, undefined);

    const list =
      (await s.okGet('getAlbumList2', { type: 'alphabeticalByName' }))
        .albumList2;
    const album = find(listOf(list, 'album'), ids.ost, 'getAlbumList2');
    assertEquals(album.userRating, 0);
    assertEquals(album.played, '');
    assertEquals(album.starred, undefined);
    assertEquals(album.playCount, undefined);

    const songXml = xmlAttrs(
      await s.xml('getSong', { id: ids.second }),
      'song',
      ids.second,
    );
    assertEquals(songXml.played, '');
    assertEquals(songXml.userRating, undefined);
    const listXml = xmlAttrs(
      await s.xml('getAlbumList2', { type: 'alphabeticalByName' }),
      'album',
      ids.ost,
    );
    assertEquals(listXml.userRating, '0');
    assertEquals(listXml.played, '');
  });
});

Deno.test('H3 average rating across users, own rating per user', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('setRating', { id: ids.theme, rating: '4' });
    await s.okGet('setRating', { id: ids.theme, rating: '5' }, 'bob');
    const admin = (await s.okGet('getSong', { id: ids.theme })).song as Item;
    const bob = (await s.okGet('getSong', { id: ids.theme }, 'bob'))
      .song as Item;
    assertEquals([admin.averageRating, admin.userRating], [4.5, 4]);
    assertEquals([bob.averageRating, bob.userRating], [4.5, 5]);
  });
});

Deno.test('H3 two-user isolation of stars, ratings and plays', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('star', { id: ids.first });
    await s.okGet('setRating', { id: ids.first, rating: '3' });
    await s.okGet('scrobble', { id: ids.first });
    const admin = (await s.okGet('getSong', { id: ids.first })).song as Item;
    assertEquals([admin.userRating, admin.playCount], [3, 1]);
    isoString(admin.starred, 'admin starred');
    const bob = (await s.okGet('getSong', { id: ids.first }, 'bob'))
      .song as Item;
    assertEquals(bob.starred, undefined);
    assertEquals(bob.userRating, undefined);
    assertEquals(bob.playCount, undefined);
    assertEquals(bob.played, '');
    const bobStarred = (await s.okGet('getStarred2', {}, 'bob'))
      .starred2 as Record<string, Item[]>;
    assertEquals(bobStarred.song, []);
  });
});

Deno.test('H3 re-starring moves an item to the top of both lists', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('star', { id: ids.first });
    const firstLike = isoString(
      ((await s.okGet('getSong', { id: ids.first })).song as Item).starred,
      'first like',
    );
    await sleep(20);
    await s.okGet('star', { id: ids.second });
    await sleep(20);
    await s.okGet('star', { id: ids.first });
    const starred2 = (await s.okGet('getStarred2')).starred2;
    const songs2 = listOf(starred2, 'song');
    assertEquals(idsOf(songs2), [ids.first, ids.second]);
    const latest = isoString(songs2[0].starred, 'latest like');
    assert(
      Date.parse(latest) > Date.parse(firstLike),
      `${latest} > ${firstLike}`,
    );
    const starred = (await s.okGet('getStarred')).starred;
    const songs = listOf(starred, 'song');
    assertEquals(idsOf(songs), [ids.first, ids.second]);
    assertEquals(songs[0].starred, latest);
  });
});

Deno.test('H3 unstar removes from both lists; starring again restores', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('star', { id: ids.first });
    await s.okGet('unstar', { id: ids.first });
    for (const op of ['getStarred', 'getStarred2']) {
      const key = op === 'getStarred' ? 'starred' : 'starred2';
      assertEquals(listOf((await s.okGet(op))[key], 'song'), [], op);
    }
    const song = (await s.okGet('getSong', { id: ids.first })).song as Item;
    assertEquals(song.starred, undefined);
    await s.okGet('star', { id: ids.first });
    for (const op of ['getStarred', 'getStarred2']) {
      const key = op === 'getStarred' ? 'starred' : 'starred2';
      assertEquals(
        idsOf(listOf((await s.okGet(op))[key], 'song')),
        [ids.first],
        op,
      );
    }
    isoString(
      ((await s.okGet('getSong', { id: ids.first })).song as Item).starred,
      'restarred',
    );
  });
});

Deno.test('H3 legacy classification: the ID decides, not the parameter', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('star', { id: ids.album });
    await s.okGet('star', { id: ids.artist });
    await s.okGet('star', { albumId: ids.first });
    for (const op of ['getStarred', 'getStarred2']) {
      const key = op === 'getStarred' ? 'starred' : 'starred2';
      const lists = (await s.okGet(op))[key];
      assertEquals(idsOf(listOf(lists, 'album')), [ids.album], op);
      assertEquals(idsOf(listOf(lists, 'artist')), [ids.artist], op);
      assertEquals(idsOf(listOf(lists, 'song')), [ids.first], op);
    }
  });
});

Deno.test('H3 unknown IDs: star/unstar/scrobble skip, setRating is 70', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    const nope = 'f'.repeat(32);
    await s.okGet('star', { id: nope });
    await s.okGet('unstar', { id: nope });
    for (const op of ['getStarred', 'getStarred2']) {
      const key = op === 'getStarred' ? 'starred' : 'starred2';
      const lists = (await s.okGet(op))[key];
      for (const kind of ['artist', 'album', 'song']) {
        assertEquals(listOf(lists, kind), [], `${op} ${kind}`);
      }
    }
    const rated = await s.get('setRating', { id: nope, rating: '3' });
    assertEquals(rated.status, 'failed');
    assertEquals(rated.error?.code, 70);
    await s.okGet('scrobble', { id: [nope, ids.first] });
    const song = (await s.okGet('getSong', { id: ids.first })).song as Item;
    assertEquals(song.playCount, 1);
    const listens = await rawSql(s.db).all(
      'SELECT track_id FROM listens',
    );
    assertEquals(listens, [{ track_id: ids.first }]);
  });
});

Deno.test('H3 scrobble submission values and timestamp count', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    const plays = async () =>
      ((await s.okGet('getSong', { id: ids.second })).song as Item).playCount;
    for (const submission of ['0', 'no', 'FALSE']) {
      await s.okGet('scrobble', { id: ids.second, submission });
      assertEquals(await plays(), undefined, `submission=${submission}`);
    }
    let expected = 0;
    for (const submission of ['TRUE', 'On', '1', '', null]) {
      await s.okGet(
        'scrobble',
        submission === null
          ? { id: ids.second }
          : { id: ids.second, submission },
      );
      expected++;
      assertEquals(await plays(), expected, `submission=${submission}`);
    }
    const wrong = await s.get('scrobble', {
      id: [ids.first, ids.second],
      time: String(T_LATE),
    });
    assertEquals(wrong.status, 'failed');
    assertEquals(wrong.error?.code, 0);
    assertEquals(await plays(), expected);
  });
});

Deno.test('H3 setRating codes: invalid value 0, missing 10, zero clears', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    for (const rating of ['9', 'abc', '1.0000000000000001']) {
      const body = await s.get('setRating', { id: ids.first, rating });
      assertEquals(body.status, 'failed', rating);
      assertEquals(body.error?.code, 0, rating);
    }
    const missing = await s.get('setRating', { id: ids.first });
    assertEquals(missing.error?.code, 10);
    await s.okGet('setRating', { id: ids.first, rating: '3' });
    assertEquals(
      ((await s.okGet('getSong', { id: ids.first })).song as Item).userRating,
      3,
    );
    await s.okGet('setRating', { id: ids.first, rating: '0' });
    assertEquals(
      ((await s.okGet('getSong', { id: ids.first })).song as Item).userRating,
      undefined,
    );
  });
});

Deno.test('H3 musicFolderId filters both favourites lists and type=starred', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('star', {
      id: [ids.first, ids.theme],
      albumId: [ids.album, ids.ost],
      artistId: [ids.artist, ids.va],
    });
    const folders = (await s.okGet('getMusicFolders')).musicFolders as {
      musicFolder: { id: number; name: string }[];
    };
    const a = folders.musicFolder.find((f) => f.name === 'A');
    assert(a, 'folder A');
    const unmatched = folders.musicFolder.some((f) => f.id === 123456789)
      ? '123456788'
      : '123456789';
    for (const op of ['getStarred', 'getStarred2']) {
      const key = op === 'getStarred' ? 'starred' : 'starred2';
      const all = (await s.okGet(op))[key];
      assertEquals(listOf(all, 'song').length, 2, `${op} unfiltered`);
      const scoped = (await s.okGet(op, { musicFolderId: String(a.id) }))[key];
      assertEquals(idsOf(listOf(scoped, 'song')), [ids.first], op);
      assertEquals(idsOf(listOf(scoped, 'album')), [ids.album], op);
      assertEquals(idsOf(listOf(scoped, 'artist')), [ids.artist], op);
      const none = (await s.okGet(op, { musicFolderId: unmatched }))[key];
      for (const kind of ['artist', 'album', 'song']) {
        assertEquals(listOf(none, kind), [], `${op} unmatched ${kind}`);
      }
    }
    const list = (await s.okGet('getAlbumList2', {
      type: 'starred',
      musicFolderId: String(a.id),
    })).albumList2;
    assertEquals(idsOf(listOf(list, 'album')), [ids.album]);
  }, true);
});

Deno.test('H3 album list type=starred: most recent like first, stable paging', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('star', { albumId: ids.album });
    await sleep(20);
    await s.okGet('star', { albumId: ids.ost });
    await sleep(20);
    await s.okGet('star', { albumId: ids.album });
    for (const op of ['getAlbumList', 'getAlbumList2']) {
      const key = op === 'getAlbumList' ? 'albumList' : 'albumList2';
      const page = async (extra: Params) =>
        idsOf(
          listOf(
            (await s.okGet(op, { type: 'starred', ...extra }))[key],
            'album',
          ),
        );
      assertEquals(await page({}), [ids.album, ids.ost], op);
      assertEquals(await page({ size: '1', offset: '0' }), [ids.album], op);
      assertEquals(await page({ size: '1', offset: '1' }), [ids.ost], op);
      assertEquals(await page({ size: '1', offset: '2' }), [], op);
    }
  });
});

Deno.test('H3 orphan: removed item leaves the lists, unstar still records', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('star', { id: ids.first });
    const [source] = await s.libraries.list();
    assert(await s.libraries.remove(source.id));
    for (const op of ['getStarred', 'getStarred2']) {
      const key = op === 'getStarred' ? 'starred' : 'starred2';
      assertEquals(listOf((await s.okGet(op))[key], 'song'), [], op);
    }
    await s.okGet('unstar', { id: ids.first });
    const again = await s.libraries.add(source.name, source.path);
    assertEquals(again.id, source.id);
    await s.scan.run();
    const song = (await s.okGet('getSong', { id: ids.first })).song as Item;
    assertEquals(song.id, ids.first);
    assertEquals(song.starred, undefined);
    for (const op of ['getStarred', 'getStarred2']) {
      const key = op === 'getStarred' ? 'starred' : 'starred2';
      assertEquals(listOf((await s.okGet(op))[key], 'song'), [], op);
    }
  });
});

Deno.test('H3 getStarred: legacy folder-style shape in JSON and XML', async () => {
  await withSetup(async (s) => {
    const { ids } = s;
    await s.okGet('star', {
      id: ids.first,
      albumId: ids.album,
      artistId: ids.artist,
    });
    const starred = (await s.okGet('getStarred')).starred;
    const artist = find(listOf(starred, 'artist'), ids.artist, 'artist');
    assertEquals(artist.name, 'Fixture Artist');
    assertEquals(artist.albumCount, undefined, 'legacy Artist');
    isoString(artist.starred, 'artist starred');
    const album = find(listOf(starred, 'album'), ids.album, 'album');
    assertEquals(album.isDir, true);
    assertEquals(album.title, 'Fixture Album');
    isoString(album.starred, 'album starred');
    const song = find(listOf(starred, 'song'), ids.first, 'song');
    assertEquals(song.isDir, false);
    assertEquals(song.title, 'First Song');
    isoString(song.starred, 'song starred');
    assertNotEquals(song.played, undefined);

    const xml = await s.xml('getStarred');
    assert(/<starred>/.test(xml), xml);
    assert(!/<starred2/.test(xml), xml);
    assertEquals(xmlAttrs(xml, 'artist', ids.artist).name, 'Fixture Artist');
    assertEquals(xmlAttrs(xml, 'album', ids.album).isDir, 'true');
    assertEquals(xmlAttrs(xml, 'song', ids.first).isDir, 'false');
  });
});
