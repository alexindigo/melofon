// tests/scan.test.ts — scanLibrary rebuilds the catalog from the fixture
// library (tags, TPE2 album artists, corrupt-file skip), keeps users and IDs
// stable across rescans; app.library answers domain queries over the result.
// The fixture root is registered as a libraries row (M3 sources); the scan
// walks every configured source.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { seedFirstUser } from '../src/users.ts';
import { createScan, scanLibrary } from '../src/scan.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createNotify } from '../src/notify.ts';

const FIXTURE_LIBRARY = await Deno.realPath('tests/fixtures/library');

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-scan-' });
  const store = await openStore(dir);
  const db = store;
  await createLibraries(store).add('Music', FIXTURE_LIBRARY);
  return {
    dir,
    store,
    db,
    close: async () => {
      await db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('a completed scan emits database on app.notify', async () => {
  const { store, close } = await setup();
  try {
    const events: string[][] = [];
    const notify = createNotify();
    notify.subscribe((types) => events.push(types));
    const scan = createScan(store, undefined, { notify });
    await scan.run();
    assertEquals(
      events.filter((e) => !e.includes('scan')),
      [['update'], ['library'], ['database'], ['update']],
    );
    assertEquals(events[0], ['scan']);
    assertEquals(events.at(-2), ['scan']);
  } finally {
    await close();
  }
});

Deno.test('scanLibrary reads tags, honors TPE2, skips corrupt files', async () => {
  const { db, store, close } = await setup();
  try {
    const counts = await scanLibrary(store);
    assertEquals(counts, {
      files: 4,
      skipped: 1,
      artists: 3,
      albums: 2,
      skippedByKind: {
        folder_unreadable: 0,
        root_unavailable: 0,
        tags_unreadable: 1,
        no_streams: 0,
        fingerprint_failed: 1,
      },
    });

    const songs = await rawSql(db).all(
      'SELECT title, track, duration_ms, is_video FROM files ORDER BY album_id, track',
    );
    const rows = songs as {
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
  const store = await openStore(dir);
  const db = store;
  try {
    const fixture =
      'tests/fixtures/library/Fixture Artist/Fixture Album/01 - First Song.mp3';
    await Deno.mkdir(`${root}/a`);
    await Deno.mkdir(`${root}/b`);
    await Deno.copyFile(fixture, `${root}/a/same.mp3`);
    await Deno.copyFile(fixture, `${root}/b/same.mp3`);
    await createLibraries(store).add('Dupes', root);
    const counts = await scanLibrary(store);
    assertEquals(counts.files, 2);
    const rows = (await rawSql(db).all(
      'SELECT id, path FROM files ORDER BY path',
    )) as { id: string; path: string }[];
    assertEquals(rows.length, 2);
    assertNotEquals(rows[0].id, rows[1].id);
  } finally {
    await db.close();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('rescan keeps users and stable IDs', async () => {
  const { db, store, close } = await setup();
  try {
    await seedFirstUser(store, {
      listen: undefined,
      dataDir: '',
      user: 'admin',
      password: 'test',
      secret: 's3cret',
    });
    await scanLibrary(store);
    const first = await rawSql(db).all(
      'SELECT id FROM files ORDER BY id',
    );
    const firstIds = first.map((r) => (r as { id: string }).id);

    await scanLibrary(store);
    const second = await rawSql(db).all(
      'SELECT id FROM files ORDER BY id',
    );
    assertEquals(
      second.map((r) => (r as { id: string }).id),
      firstIds,
    );
    const users = await rawSql(db).all(
      'SELECT count(*) AS n FROM users',
    );
    assertEquals(Number((users[0] as { n: bigint }).n), 1);
  } finally {
    await close();
  }
});

Deno.test('rescan keeps user-state rows (listens/stars/ratings/playlists/play_queues)', async () => {
  const { db, store, close } = await setup();
  try {
    await scanLibrary(store);
    await rawSql(db).run(
      "INSERT INTO listens (user_id, track_id, played_at, duration_ms, source) VALUES ('u1', 't1', now(), 1000, 'opensubsonic')",
    );
    await rawSql(db).run(
      "INSERT INTO stars (user_id, target_id, target_type, starred_at) VALUES ('u1', 't1', 'song', now())",
    );
    await rawSql(db).run(
      `INSERT INTO star_events (user_id, target_id, target_type, action, occurred_at) VALUES ('u1', 't1', 'song', 'star', now())`,
    );
    await rawSql(db).run(
      "INSERT INTO ratings (user_id, target_id, rating) VALUES ('u1', 't1', 5)",
    );
    await rawSql(db).run(
      "INSERT INTO playlists (id, user_id, name, created_at, changed_at) VALUES ('p1', 'u1', 'Mix', now(), now())",
    );
    await rawSql(db).run(
      "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES ('p1', 0, 't1')",
    );
    await rawSql(db).run(
      "INSERT INTO play_queues (user_id, current_index, position_ms, changed_at, track_ids) VALUES ('u1', 0, 0, now(), ['t1'])",
    );

    await scanLibrary(store);

    const res = await rawSql(db).all(
      `SELECT
        (SELECT count(*) FROM listens) AS listens,
        (SELECT count(*) FROM stars) AS stars,
        (SELECT count(*) FROM star_events) AS star_events,
        (SELECT count(*) FROM ratings) AS ratings,
        (SELECT count(*) FROM playlists) AS playlists,
        (SELECT count(*) FROM playlist_tracks) AS playlist_tracks,
        (SELECT count(*) FROM play_queues) AS play_queues`,
    );
    const row = res[0] as Record<string, bigint | number>;
    for (
      const table of [
        'listens',
        'stars',
        'star_events',
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
  const { store, close } = await setup();
  try {
    await scanLibrary(store);
    const library = createLibrary(store);
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
  const { store, close } = await setup();
  try {
    await scanLibrary(store);
    const library = createLibrary(store);
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
  const { store, close } = await setup();
  try {
    await scanLibrary(store);
    const library = createLibrary(store);
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
  const { store, close } = await setup();
  try {
    await scanLibrary(store);
    const library = createLibrary(store);
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
  const { store, close } = await setup();
  try {
    await scanLibrary(store);
    const library = createLibrary(store);
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
