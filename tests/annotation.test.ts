// tests/annotation.test.ts — M2 annotation + listens over the opensubsonic
// hat: star/unstar (song/album/artist), setRating, scrobble (append-only;
// submission=false goes to now-playing, never listens), getStarred2,
// getUser, getRandomSongs. Fixture library + seeded admin/test user per test.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createUserService } from '../src/user.ts';
import { createLibrary } from '../src/library.ts';
import { createAnnotation } from '../src/annotation.ts';
import { createListens } from '../src/listens.ts';
import { createNowPlaying } from '../src/nowplaying.ts';
import { createPlayer } from '../src/player.ts';
import { createPlayback } from '../src/playback.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';

const AUTH = 'u=admin&p=test&v=1.16.1&c=melofon-test';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-ann-' });
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
  const libraries = createLibraries(store);
  await libraries.add('Music', 'tests/fixtures/library');
  await scanLibrary(store);
  const library = createLibrary(store);
  const player = createPlayer();
  const nowPlaying = createNowPlaying(store);
  const bag = {
    cfg,
    libraries,
    user: createUserService(store, cfg),
    library,
    annotation: createAnnotation(store),
    listens: createListens(store),
    nowPlaying,
    player,
    playback: createPlayback({ player, nowPlaying, library, cfg }),
  };
  const core = await pathfinder({ roots: ['core/'], app: { store, cfg } });
  const app = facade(core, await loadLayers({ app: bag }));
  const songs = await rawSql(db).all(
    "SELECT id, album_id, artist_id FROM files WHERE title != '' ORDER BY path",
  );
  const songIds = songs as {
    id: string;
    album_id: string;
    artist_id: string;
  }[];
  return {
    db,
    app,
    songIds,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function jsonBody(res: Response) {
  const body = await res.json();
  return (body as Record<string, Record<string, unknown>>)[
    'subsonic-response'
  ];
}

Deno.test('star a song, then getStarred2 lists it with a starred date', async () => {
  const { app, songIds, close } = await setup();
  try {
    const id = songIds[0].id;
    const star = await app(
      new Request(`http://x/rest/star?${AUTH}&f=json&id=${id}`),
    );
    assertEquals((await jsonBody(star)).status, 'ok');

    const res = await app(
      new Request(`http://x/rest/getStarred2?${AUTH}&f=json`),
    );
    const body = await jsonBody(res);
    assertEquals(body.status, 'ok');
    const starred2 = body.starred2 as {
      song: { id: string; starred: string }[];
    };
    assertEquals(starred2.song.length, 1);
    assertEquals(starred2.song[0].id, id);
    assert(starred2.song[0].starred.endsWith('Z'));
  } finally {
    await close();
  }
});

Deno.test('star accepts albumId/artistId and unstar removes them', async () => {
  const { app, songIds, close } = await setup();
  try {
    const { album_id, artist_id } = songIds[0];
    const star = await app(
      new Request(
        `http://x/rest/star?${AUTH}&f=json&albumId=${album_id}&artistId=${artist_id}`,
      ),
    );
    assertEquals((await jsonBody(star)).status, 'ok');

    let res = await app(
      new Request(`http://x/rest/getStarred2?${AUTH}&f=json`),
    );
    let starred2 = (await jsonBody(res)).starred2 as {
      album: { id: string }[];
      artist: { id: string }[];
    };
    assertEquals(starred2.album.map((a) => a.id), [album_id]);
    assertEquals(starred2.artist.map((a) => a.id), [artist_id]);

    const unstar = await app(
      new Request(
        `http://x/rest/unstar?${AUTH}&f=json&albumId=${album_id}&artistId=${artist_id}`,
      ),
    );
    assertEquals((await jsonBody(unstar)).status, 'ok');
    res = await app(
      new Request(`http://x/rest/getStarred2?${AUTH}&f=json`),
    );
    starred2 = (await jsonBody(res)).starred2 as {
      album: { id: string }[];
      artist: { id: string }[];
    };
    assertEquals(starred2.album.length, 0);
    assertEquals(starred2.artist.length, 0);
  } finally {
    await close();
  }
});

Deno.test('star works via POST form too', async () => {
  const { app, songIds, close } = await setup();
  try {
    const res = await app(
      new Request('http://x/rest/star', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `${AUTH}&f=json&id=${songIds[0].id}`,
      }),
    );
    assertEquals((await jsonBody(res)).status, 'ok');
  } finally {
    await close();
  }
});

Deno.test('setRating upserts and 0 clears', async () => {
  const { app, db, songIds, close } = await setup();
  try {
    const id = songIds[0].id;
    let res = await app(
      new Request(
        `http://x/rest/setRating?${AUTH}&f=json&id=${id}&rating=4`,
      ),
    );
    assertEquals((await jsonBody(res)).status, 'ok');
    let rows = await rawSql(db).all(
      'SELECT rating FROM ratings',
    );
    assertEquals(
      Number((rows[0] as { rating: number }).rating),
      4,
    );

    res = await app(
      new Request(
        `http://x/rest/setRating?${AUTH}&f=json&id=${id}&rating=2`,
      ),
    );
    assertEquals((await jsonBody(res)).status, 'ok');
    rows = await rawSql(db).all('SELECT rating FROM ratings');
    assertEquals(rows.length, 1);
    assertEquals(
      Number((rows[0] as { rating: number }).rating),
      2,
    );

    res = await app(
      new Request(
        `http://x/rest/setRating?${AUTH}&f=json&id=${id}&rating=0`,
      ),
    );
    assertEquals((await jsonBody(res)).status, 'ok');
    rows = await rawSql(db).all('SELECT rating FROM ratings');
    assertEquals(rows.length, 0);
  } finally {
    await close();
  }
});

Deno.test('setRating rejects out-of-range values', async () => {
  const { app, songIds, close } = await setup();
  try {
    const res = await app(
      new Request(
        `http://x/rest/setRating?${AUTH}&f=json&id=${songIds[0].id}&rating=9`,
      ),
    );
    const body = await jsonBody(res);
    assertEquals(body.status, 'failed');
    assertEquals((body.error as { code: number }).code, 0);
  } finally {
    await close();
  }
});

Deno.test('scrobble submission=true appends listens rows, never updates', async () => {
  const { app, db, songIds, close } = await setup();
  try {
    const id = songIds[0].id;
    for (let i = 0; i < 2; i++) {
      const res = await app(
        new Request(
          `http://x/rest/scrobble?${AUTH}&f=json&id=${id}&submission=true`,
        ),
      );
      assertEquals((await jsonBody(res)).status, 'ok');
    }
    const rows = await rawSql(db).all(
      'SELECT track_id, source FROM listens',
    );
    const listens = rows as {
      track_id: string;
      source: string;
    }[];
    assertEquals(listens.length, 2);
    assertEquals(listens[0].track_id, id);
    assertEquals(listens[0].source, 'opensubsonic');
  } finally {
    await close();
  }
});

Deno.test('scrobble honors the time parameter for offline scrobbles', async () => {
  const { app, db, songIds, close } = await setup();
  try {
    const res = await app(
      new Request(
        `http://x/rest/scrobble?${AUTH}&f=json&id=${
          songIds[0].id
        }&submission=true&time=1700000000000`,
      ),
    );
    assertEquals((await jsonBody(res)).status, 'ok');
    const rows = await rawSql(db).all(
      'SELECT epoch_ms(played_at)::BIGINT AS ms FROM listens',
    );
    assertEquals(
      Number((rows[0] as { ms: bigint }).ms),
      1700000000000,
    );
  } finally {
    await close();
  }
});

Deno.test('scrobble submission=false does not append listens', async () => {
  const { app, db, songIds, close } = await setup();
  try {
    const res = await app(
      new Request(
        `http://x/rest/scrobble?${AUTH}&f=json&id=${
          songIds[0].id
        }&submission=false`,
      ),
    );
    assertEquals((await jsonBody(res)).status, 'ok');
    const rows = await rawSql(db).all(
      'SELECT count(*) AS n FROM listens',
    );
    assertEquals(Number((rows[0] as { n: bigint }).n), 0);
  } finally {
    await close();
  }
});

Deno.test('getNowPlaying is an empty list when nobody is playing', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/getNowPlaying?${AUTH}&f=json`),
    );
    const body = await jsonBody(res);
    assertEquals(body.status, 'ok');
    assertEquals(
      (body.nowPlaying as { entry: unknown[] }).entry.length,
      0,
    );
  } finally {
    await close();
  }
});

Deno.test('getUser returns the authenticated user', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/getUser?${AUTH}&f=json`),
    );
    const body = await jsonBody(res);
    assertEquals(body.status, 'ok');
    const user = body.user as {
      username: string;
      playlistRole: boolean;
      folder: unknown;
    };
    assertEquals(user.username, 'admin');
    assertEquals(user.playlistRole, true);
    // folder carries the wire ints of the real sources (one in this setup),
    // never [0] — spec types folder as an array of int.
    assert(Array.isArray(user.folder));
    assertEquals((user.folder as unknown[]).length, 1);
    assertEquals(typeof (user.folder as number[])[0], 'number');
  } finally {
    await close();
  }
});

Deno.test('getRandomSongs returns catalog songs, size honored', async () => {
  const { app, close } = await setup();
  try {
    const res = await app(
      new Request(`http://x/rest/getRandomSongs?${AUTH}&f=json&size=2`),
    );
    const body = await jsonBody(res);
    assertEquals(body.status, 'ok');
    const songs = (body.randomSongs as { song: { id: string }[] }).song;
    assertEquals(songs.length, 2);
    assert(songs.every((s) => typeof s.id === 'string' && s.id !== ''));
  } finally {
    await close();
  }
});
