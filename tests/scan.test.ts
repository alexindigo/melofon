// tests/scan.test.ts — scanLibrary rebuilds the catalog from the fixture
// library (tags, TPE2 album artists, corrupt-file skip), keeps users and IDs
// stable across rescans; app.library answers domain queries over the result.
// The fixture root is registered as a libraries row (M3 sources); the scan
// walks every configured source.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { openDb } from '../src/db.ts';
import { seedFirstUser } from '../src/users.ts';
import { createScan, scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createNotify } from '../src/notify.ts';

const FIXTURE_LIBRARY = 'tests/fixtures/library';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-scan-' });
  const db = await openDb(dir);
  await createLibraries(db).add('Music', FIXTURE_LIBRARY);
  return {
    dir,
    db,
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('a completed scan emits database on app.notify', async () => {
  const { db, close } = await setup();
  try {
    const events: string[][] = [];
    const notify = createNotify();
    notify.subscribe((types) => events.push(types));
    const scan = createScan(db, undefined, { notify });
    await scan.run();
    assertEquals(events, [['database']]);
  } finally {
    await close();
  }
});

Deno.test('scanLibrary reads tags, honors TPE2, skips corrupt files', async () => {
  const { db, close } = await setup();
  try {
    const counts = await scanLibrary(db);
    assertEquals(counts, { files: 4, skipped: 1, artists: 3, albums: 2 });

    const songs = await db.conn.runAndReadAll(
      'SELECT title, track, duration_ms, is_video FROM files ORDER BY album_id, track',
    );
    const rows = songs.getRowObjects() as {
      title: string;
      track: number;
      duration_ms: number;
      is_video: boolean;
    }[];
    assertEquals(rows.length, 4);
    for (const row of rows) assert(Number(row.duration_ms) > 0);
    // M4: the fixture mp4 is the only video row (probe-decided). album_id
    // order is hash order — sort by title for a deterministic assertion.
    assertEquals(
      rows.map((r) => [r.title, r.is_video]).sort(),
      [
        ['Clip', true],
        ['First Song', false],
        ['Second Song', false],
        ['Theme', false],
      ],
    );
  } finally {
    await close();
  }
});

Deno.test('same-named files in different dirs get distinct ids', async () => {
  // Regression: walkAudio's rel must be anchored at the source root — a
  // basename-only rel makes <dirA>/same.mp3 and <dirB>/same.mp3 collide on
  // the files PRIMARY KEY and rolls back the whole scan.
  const dir = await Deno.makeTempDir({ prefix: 'melofon-dupes-db-' });
  const root = await Deno.makeTempDir({ prefix: 'melofon-dupes-' });
  const db = await openDb(dir);
  try {
    const fixture =
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
    await Deno.mkdir(`${root}/a`);
    await Deno.mkdir(`${root}/b`);
    await Deno.copyFile(fixture, `${root}/a/same.mp3`);
    await Deno.copyFile(fixture, `${root}/b/same.mp3`);
    await createLibraries(db).add('Dupes', root);
    const counts = await scanLibrary(db);
    assertEquals(counts.files, 2);
    const rows = (await db.conn.runAndReadAll(
      'SELECT id, path FROM files ORDER BY path',
    )).getRowObjects() as { id: string; path: string }[];
    assertEquals(rows.length, 2);
    assertNotEquals(rows[0].id, rows[1].id);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('rescan keeps users and stable IDs', async () => {
  const { db, close } = await setup();
  try {
    await seedFirstUser(db, {
      listen: undefined,
      dataDir: '',
      user: 'admin',
      password: 'test',
      secret: 's3cret',
    });
    await scanLibrary(db);
    const first = await db.conn.runAndReadAll(
      'SELECT id FROM files ORDER BY id',
    );
    const firstIds = first.getRowObjects().map((r) => (r as { id: string }).id);

    await scanLibrary(db);
    const second = await db.conn.runAndReadAll(
      'SELECT id FROM files ORDER BY id',
    );
    assertEquals(
      second.getRowObjects().map((r) => (r as { id: string }).id),
      firstIds,
    );
    const users = await db.conn.runAndReadAll(
      'SELECT count(*) AS n FROM users',
    );
    assertEquals(Number((users.getRowObjects()[0] as { n: bigint }).n), 1);
  } finally {
    await close();
  }
});

Deno.test('rescan keeps user-state rows (listens/stars/ratings/playlists/play_queues)', async () => {
  const { db, close } = await setup();
  try {
    await scanLibrary(db);
    await db.conn.run(
      "INSERT INTO listens (user_id, track_id, played_at, duration_ms, source) VALUES ('u1', 't1', now(), 1000, 'opensubsonic')",
    );
    await db.conn.run(
      "INSERT INTO stars (user_id, target_id, target_type, starred_at) VALUES ('u1', 't1', 'song', now())",
    );
    await db.conn.run(
      "INSERT INTO ratings (user_id, target_id, rating) VALUES ('u1', 't1', 5)",
    );
    await db.conn.run(
      "INSERT INTO playlists (id, user_id, name, created_at, changed_at) VALUES ('p1', 'u1', 'Mix', now(), now())",
    );
    await db.conn.run(
      "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES ('p1', 0, 't1')",
    );
    await db.conn.run(
      "INSERT INTO play_queues (user_id, current_id, position_ms, changed_at, track_ids) VALUES ('u1', 't1', 0, now(), ['t1'])",
    );

    await scanLibrary(db);

    const res = await db.conn.runAndReadAll(
      `SELECT
        (SELECT count(*) FROM listens) AS listens,
        (SELECT count(*) FROM stars) AS stars,
        (SELECT count(*) FROM ratings) AS ratings,
        (SELECT count(*) FROM playlists) AS playlists,
        (SELECT count(*) FROM playlist_tracks) AS playlist_tracks,
        (SELECT count(*) FROM play_queues) AS play_queues`,
    );
    const row = res.getRowObjects()[0] as Record<string, bigint | number>;
    for (
      const table of [
        'listens',
        'stars',
        'ratings',
        'playlists',
        'playlist_tracks',
        'play_queues',
      ]
    ) {
      assertEquals(Number(row[table]), 1, `${table} lost rows on rescan`);
    }
  } finally {
    await close();
  }
});

Deno.test('library.listArtists returns album artists with album counts', async () => {
  const { db, close } = await setup();
  try {
    await scanLibrary(db);
    const library = createLibrary(db);
    const artists = await library.listArtists();
    assertEquals(
      artists.map((a) => [a.name, a.albumCount]),
      [
        ['Fixture Artist', 1],
        ['Various Artists', 1],
      ],
    );
  } finally {
    await close();
  }
});

Deno.test('library.getAlbum returns the album with ordered songs', async () => {
  const { db, close } = await setup();
  try {
    await scanLibrary(db);
    const library = createLibrary(db);
    const artists = await library.listArtists();
    const fixtureArtist = artists.find((a) => a.name === 'Fixture Artist')!;
    const albums = await library.search3('Fixture Album', {
      artistCount: 20,
      artistOffset: 0,
      albumCount: 20,
      albumOffset: 0,
      songCount: 20,
      songOffset: 0,
    });
    const albumId = albums.albums[0].id;
    const got = await library.getAlbum(albumId);
    assert(got !== null);
    assertEquals(got.album.name, 'Fixture Album');
    assertEquals(got.album.artistId, fixtureArtist.id);
    assertEquals(got.album.songCount, 3);
    assertEquals(got.songs.map((s) => [s.track, s.title]), [
      [1, 'First Song'],
      [2, 'Second Song'],
      [3, 'Clip'],
    ]);
    assertEquals(got.songs[0].suffix, 'mp3');
    assertEquals(got.songs[0].contentType, 'audio/mpeg');
    assertNotEquals(got.songs[0].durationMs, null);
    // M4: the music video rides the same album row set, flagged isVideo.
    assertEquals(got.songs[0].isVideo, false);
    assertEquals(got.songs[2].isVideo, true);
    assertEquals(got.songs[2].suffix, 'mp4');
    assertEquals(got.songs[2].contentType, 'video/mp4');
  } finally {
    await close();
  }
});

Deno.test('library.getSong returns one song with album and artist names', async () => {
  const { db, close } = await setup();
  try {
    await scanLibrary(db);
    const library = createLibrary(db);
    const found = await library.search3('Theme', {
      artistCount: 20,
      artistOffset: 0,
      albumCount: 20,
      albumOffset: 0,
      songCount: 20,
      songOffset: 0,
    });
    assertEquals(found.songs.length, 1);
    const song = await library.getSong(found.songs[0].id);
    assert(song !== null);
    assertEquals(song.title, 'Theme');
    assertEquals(song.artistName, 'Probe Performer');
    assertEquals(song.albumName, 'Fixture OST');
  } finally {
    await close();
  }
});

Deno.test('library.search3 matches artists, albums, and songs by substring', async () => {
  const { db, close } = await setup();
  try {
    await scanLibrary(db);
    const library = createLibrary(db);
    const res = await library.search3('fixture', {
      artistCount: 20,
      artistOffset: 0,
      albumCount: 20,
      albumOffset: 0,
      songCount: 20,
      songOffset: 0,
    });
    assertEquals(res.artists.map((a) => a.name), ['Fixture Artist']);
    assertEquals(res.albums.map((a) => a.name), [
      'Fixture Album',
      'Fixture OST',
    ]);
    assertEquals(res.songs.length, 0); // titles have no "fixture"
    const none = await library.search3('zzzz', {
      artistCount: 20,
      artistOffset: 0,
      albumCount: 20,
      albumOffset: 0,
      songCount: 20,
      songOffset: 0,
    });
    assertEquals(none, { artists: [], albums: [], songs: [] });
  } finally {
    await close();
  }
});

Deno.test('library.songPath and albumCoverPath resolve real files', async () => {
  const { db, close } = await setup();
  try {
    await scanLibrary(db);
    const library = createLibrary(db);
    const found = await library.search3('First', {
      artistCount: 20,
      artistOffset: 0,
      albumCount: 20,
      albumOffset: 0,
      songCount: 20,
      songOffset: 0,
    });
    const path = await library.songPath(found.songs[0].id);
    assert(path !== null && path.endsWith('01 - First Song.mp3'));

    const albums = await library.search3('Fixture Album', {
      artistCount: 20,
      artistOffset: 0,
      albumCount: 20,
      albumOffset: 0,
      songCount: 20,
      songOffset: 0,
    });
    const cover = await library.albumCoverPath(albums.albums[0].id);
    assert(cover !== null && cover.endsWith('cover.jpg'));

    const ost = await library.search3('Fixture OST', {
      artistCount: 20,
      artistOffset: 0,
      albumCount: 20,
      albumOffset: 0,
      songCount: 20,
      songOffset: 0,
    });
    assertEquals(await library.albumCoverPath(ost.albums[0].id), null);
    assertEquals(await library.songPath('no-such-id'), null);
  } finally {
    await close();
  }
});
