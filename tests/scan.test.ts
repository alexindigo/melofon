// tests/scan.test.ts — scanLibrary rebuilds the catalog from the fixture
// library (tags, TPE2 album artists, corrupt-file skip), keeps users and IDs
// stable across rescans; app.library answers domain queries over the result.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { openDb } from '../src/db.ts';
import { seedFirstUser } from '../src/users.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';

const FIXTURE_LIBRARY = 'tests/fixtures/library';

async function setup() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-scan-' });
  const db = await openDb(dir);
  return {
    dir,
    db,
    close: async () => {
      db.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('scanLibrary reads tags, honors TPE2, skips corrupt files', async () => {
  const { db, close } = await setup();
  try {
    const counts = await scanLibrary(db, FIXTURE_LIBRARY);
    assertEquals(counts, { files: 3, skipped: 1, artists: 3, albums: 2 });

    const songs = await db.conn.runAndReadAll(
      'SELECT title, track, duration_ms FROM files ORDER BY album_id, track',
    );
    const rows = songs.getRowObjects() as {
      title: string;
      track: number;
      duration_ms: number;
    }[];
    assertEquals(rows.length, 3);
    for (const row of rows) assert(Number(row.duration_ms) > 0);
  } finally {
    await close();
  }
});

Deno.test('rescan keeps users and stable IDs', async () => {
  const { db, close } = await setup();
  try {
    await seedFirstUser(db, {
      listen: undefined,
      dataDir: '',
      library: undefined,
      user: 'admin',
      password: 'test',
      secret: 's3cret',
    });
    await scanLibrary(db, FIXTURE_LIBRARY);
    const first = await db.conn.runAndReadAll(
      'SELECT id FROM files ORDER BY id',
    );
    const firstIds = first.getRowObjects().map((r) => (r as { id: string }).id);

    await scanLibrary(db, FIXTURE_LIBRARY);
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

Deno.test('library.listArtists returns album artists with album counts', async () => {
  const { db, close } = await setup();
  try {
    await scanLibrary(db, FIXTURE_LIBRARY);
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
    await scanLibrary(db, FIXTURE_LIBRARY);
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
    assertEquals(got.album.songCount, 2);
    assertEquals(got.songs.map((s) => [s.track, s.title]), [
      [1, 'First Song'],
      [2, 'Second Song'],
    ]);
    assertEquals(got.songs[0].suffix, 'mp3');
    assertEquals(got.songs[0].contentType, 'audio/mpeg');
    assertNotEquals(got.songs[0].durationMs, null);
  } finally {
    await close();
  }
});

Deno.test('library.getSong returns one song with album and artist names', async () => {
  const { db, close } = await setup();
  try {
    await scanLibrary(db, FIXTURE_LIBRARY);
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
    await scanLibrary(db, FIXTURE_LIBRARY);
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
    await scanLibrary(db, FIXTURE_LIBRARY);
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
