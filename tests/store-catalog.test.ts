import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  type CatalogFile,
  type CatalogSnapshot,
  createCatalogStore,
} from '../src/store/catalog.ts';
import { openStore } from '../src/store/index.ts';
import { createLibraries } from '../src/libraries.ts';
import { createLibrary } from '../src/library.ts';
import { createScan, scanLibrary } from '../src/scan.ts';
import { createMedia } from '../src/media.ts';
import { domainFixture } from './helpers/store.ts';

function snapshot(): CatalogSnapshot {
  const file: CatalogFile = {
    id: 'song',
    path: "/music/song'.mp3",
    rel: "song'.mp3",
    libraryId: 'lib',
    stat: { size: 1234, mtime_ms: 1000, dev: 1, ino: 2 },
    fingerprint: 'afp/1:one',
    pcmMd5: 'pcm',
    title: "Song'",
    albumId: 'album',
    artistId: 'artist',
    track: 1,
    disc: 2,
    durationMs: 2500,
    genre: 'Jazz',
    year: 2001,
    isVideo: false,
  };
  return {
    artists: [{ id: 'artist', name: "Artist'" }],
    albums: [{ id: 'album', name: "Album'", albumArtistId: 'artist' }],
    files: [file],
    events: [],
    retainedIds: [],
  };
}

Deno.test('store.catalog replaceCatalog round-trips plain identity snapshots and retains absent first-seen', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    const next = snapshot();
    await t.domain.replaceCatalog(next);
    const retained = await t.domain.identitySnapshot();
    assertEquals(retained, [{
      id: 'song',
      library_id: 'lib',
      rel_path: "song'.mp3",
      size: 1234,
      mtime_ms: 1000,
      dev: 1,
      ino: 2,
      fingerprint: 'afp/1:one',
      pcm_md5: 'pcm',
    }]);
    assertEquals(JSON.parse(JSON.stringify(retained)), retained);
    const firstSeen = await t.domain.firstSeen(['song']);
    assert(firstSeen.song > 0);
    assertEquals((await t.domain.getSong('song'))?.firstSeenMs, firstSeen.song);
    assertEquals(
      (await t.domain.getAlbum('album'))?.album.createdAtMs,
      firstSeen.song,
    );
    const moved = {
      ...next.files[0],
      path: '/music/new.mp3',
      rel: 'new.mp3',
      stat: { size: null, mtime_ms: null, dev: null, ino: null },
      fingerprint: null,
      pcmMd5: null,
    };
    await t.domain.replaceCatalog({
      ...next,
      retainedIds: retained.map((r) => r.id),
      files: [moved],
      events: [{ kind: 'linked', file: moved, from: retained[0] }],
    });
    assertEquals(await t.domain.identitySnapshot(), [{
      ...retained[0],
      rel_path: 'new.mp3',
      size: null,
      mtime_ms: null,
      dev: null,
      ino: null,
      fingerprint: null,
      pcm_md5: null,
    }]);
    assertEquals(await t.domain.firstSeen(['song']), firstSeen);
    const event = (await t.domain.events({ limit: 1 }))[0];
    assertEquals([
      event.fromPath,
      event.toPath,
      event.fromLibraryId,
      event.toLibraryId,
    ], ["song'.mp3", 'new.mp3', 'lib', 'lib']);
    await t.domain.replaceCatalog({
      artists: [],
      albums: [],
      files: [],
      events: [],
      retainedIds: ['song'],
    });
    assertEquals(await t.domain.getSong('song'), null);
    assertEquals(await t.domain.firstSeen(['song']), firstSeen);
    assertEquals(await t.all('SELECT present FROM file_identity'), [{
      present: false,
    }]);
  } finally {
    await t.close();
  }
});

Deno.test('store.catalog replaceCatalog duplicate file id rolls back every table before queued readers resume', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    await t.domain.addLibrary({ id: 'lib', name: 'Music', path: '/music' });
    await t.domain.replaceCatalog(snapshot());
    const tables = [
      'libraries',
      'artists',
      'albums',
      'files',
      'file_identity',
      'file_events',
    ];
    const before = await Promise.all(
      tables.map((table) => t.all(`SELECT * FROM ${table}`)),
    );
    const album = await t.domain.getAlbum('album');
    const next = snapshot();
    next.retainedIds = ['song'];
    next.artists[0].name = 'Changed';
    next.files.push({
      ...next.files[0],
      path: '/music/second.mp3',
      rel: 'second.mp3',
    });
    next.events.push({
      kind: 'ambiguous',
      file: next.files[0],
      candidates: ['song'],
    });
    const failure = assertRejects(
      () => t.domain.replaceCatalog(next),
      Error,
      'Constraint',
    );
    const queuedRead = t.domain.getAlbum('album');
    await failure;
    assertEquals(await queuedRead, album);
    assertEquals(
      await Promise.all(tables.map((table) => t.all(`SELECT * FROM ${table}`))),
      before,
    );
    assertEquals(await t.domain.events({ limit: 10 }), []);
    await t.domain.replaceCatalog({ ...snapshot(), retainedIds: ['song'] });
    assertEquals(await t.domain.getAlbum('album'), album);
  } finally {
    await t.close();
  }
});

Deno.test('store.catalog scan hands over a plain fixture snapshot without holding the queue during fingerprint I/O', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-catalog-scan-' });
  const store = await openStore(dir);
  try {
    await createLibraries(store).add('Music', 'tests/fixtures/library');
    const media = createMedia();
    let peakBytes = 0;
    let peakFiles = 0;
    let fingerprintCalls = 0;
    const observed = {
      ...store,
      catalog: {
        ...store.catalog,
        async replaceCatalog(data: CatalogSnapshot) {
          const serialized = JSON.stringify(data);
          peakBytes = Math.max(
            peakBytes,
            new TextEncoder().encode(serialized).length,
          );
          peakFiles = Math.max(peakFiles, data.files.length);
          await store.catalog.replaceCatalog(JSON.parse(serialized));
        },
      },
    };
    const counts = await scanLibrary(observed, {
      ...media,
      async fingerprint(path) {
        fingerprintCalls++;
        await store.ping(); // Would deadlock if the walk held an exclusive slot.
        return await media.fingerprint(path);
      },
    });
    assertEquals(counts, { files: 4, skipped: 1, artists: 3, albums: 2 });
    assert(fingerprintCalls > 0);
    assertEquals(peakFiles, 4);
    assert(peakBytes > 0);
    const songs = await createLibrary(store).listSongs({ offset: 0, size: 10 });
    assertEquals(songs.length, 4);
    assert(songs.every((song) => typeof song.firstSeenMs === 'number'));
    assertEquals((await createScan(store).status()).folderCount, 1);
    console.log(`catalog-snapshot peak_bytes=${peakBytes} files=${peakFiles}`);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store.catalog identity reads retain absent first-seen, group only present duplicates and decode event arrays', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    await t.run(
      `INSERT INTO file_identity (id, first_seen_at, last_seen_at, library_id, rel_path, present, fingerprint) VALUES
      ('a', epoch_ms(1000), epoch_ms(1000), 'lib', 'a.mp3', true, 'afp/1:one'),
      ('b', epoch_ms(2000), epoch_ms(2000), 'lib', 'b.mp3', true, 'afp/1:one'),
      ('gone', epoch_ms(3000), epoch_ms(3000), 'lib', 'gone.mp3', false, 'afp/1:one')`,
    );
    assertEquals(await t.domain.firstSeen(['a', 'gone', 'missing', 'a']), {
      a: 1000,
      gone: 3000,
    });
    assertEquals(await t.domain.firstSeen([]), {});
    assertEquals(await t.domain.duplicates(), [{
      fingerprint: 'afp/1:one',
      files: [
        { id: 'a', libraryId: 'lib', relPath: 'a.mp3' },
        { id: 'b', libraryId: 'lib', relPath: 'b.mp3' },
      ],
    }]);
    await t.run(
      `INSERT INTO file_events (occurred_at, kind, file_id, candidates) VALUES
      (epoch_ms(4000), 'ambiguous', 'a', ['b', 'gone']),
      (epoch_ms(5000), 'audio_changed', 'b', NULL)`,
    );
    const events = await t.domain.events({ limit: 10 });
    assertEquals(
      events.map((e) => [e.occurredAtMs, e.kind, e.fileId, e.candidates]),
      [
        [5000, 'audio_changed', 'b', []],
        [4000, 'ambiguous', 'a', ['b', 'gone']],
      ],
    );
    assertEquals(events[0].fingerprint, null);
    assertEquals(events[0].fromPath, null);
    assertEquals((await t.domain.events({ limit: 1 }))[0], events[0]);
    assertEquals(await t.domain.events({ limit: 0 }), []);
    await assertRejects(
      () => t.domain.events({ limit: -1 }),
      RangeError,
      'invalid event limit',
    );
    assert(JSON.stringify(events).length > 0);
  } finally {
    await t.close();
  }
});

Deno.test('store.catalog libraries add atomically, deduplicate concurrent paths and list by name', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    const row = { id: "lib'", name: "Z'", path: "/music'" };
    assertEquals(
      await Promise.all([
        t.domain.addLibrary(row),
        t.domain.addLibrary({ ...row, id: 'other', name: 'Other' }),
      ]),
      [row, row],
    );
    const first = { id: 'first', name: 'A', path: '/first' };
    t.failCommit();
    await assertRejects(
      () => t.domain.addLibrary(first),
      Error,
      'injected commit failure',
    );
    assertEquals(await t.domain.listLibraries(), [row]);
    await t.domain.addLibrary(first);
    assertEquals(await t.domain.listLibraries(), [first, row]);
  } finally {
    await t.close();
  }
});

Deno.test('store.catalog removeLibrary rolls back all catalog cleanup and preserves user state', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    await t.domain.addLibrary({ id: 'lib', name: 'Music', path: '/music' });
    await t.run("UPDATE files SET library_id = 'lib'");
    await t.run("INSERT INTO ratings VALUES ('u', 'song', 5)");
    await t.run(
      'CREATE TABLE album_reference (id VARCHAR REFERENCES albums(id))',
    );
    await t.run("INSERT INTO album_reference VALUES ('album')");
    await assertRejects(
      () => t.domain.removeLibrary('lib'),
      Error,
      'Constraint',
    );
    assertEquals((await t.domain.listLibraries()).length, 1);
    assertEquals((await t.domain.getAlbum('album'))?.songs.map((s) => s.id), [
      'song',
    ]);
    assertEquals((await t.domain.listArtists()).length, 1);
    await t.run('DELETE FROM album_reference');
    assertEquals(await t.domain.removeLibrary('lib'), true);
    assertEquals(await t.domain.listLibraries(), []);
    assertEquals(await t.domain.getSong('song'), null);
    assertEquals(await t.domain.listArtists(), []);
    assertEquals(await t.domain.getAlbum('album'), null);
    assertEquals(await t.all('SELECT target_id FROM ratings'), [{
      target_id: 'song',
    }]);
    assertEquals(await t.domain.removeLibrary('lib'), false);
  } finally {
    await t.close();
  }
});

Deno.test('store.catalog artist and album reads return plain rows, scoped counts and stable ordering', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    await t.run("INSERT INTO libraries VALUES ('lib', 'Music', '/music')");
    await t.run(
      "UPDATE files SET library_id = 'lib', duration_ms = 1200, year = 2001 WHERE id = 'song'",
    );
    await t.run("INSERT INTO artists VALUES ('performer', 'Performer')");
    assertEquals(await t.domain.listArtists(), [{
      id: 'artist',
      name: 'Artist',
      albumCount: 1,
    }]);
    assertEquals(await t.domain.listArtists('missing'), []);
    assertEquals(await t.domain.getArtist('performer'), null);
    assertEquals(await t.domain.artistById('performer'), {
      id: 'performer',
      name: 'Performer',
      albumCount: 0,
    });
    const album = {
      id: 'album',
      name: 'Album',
      artistId: 'artist',
      artistName: 'Artist',
      songCount: 1,
      durationMs: 1200,
      year: 2001,
      createdAtMs: null,
    };
    assertEquals(await t.domain.albumsByArtist('artist'), [album]);
    assertEquals(
      await t.domain.listAlbums({ sort: 'name', size: 10, offset: 0 }),
      [album],
    );
    assertEquals(
      await t.domain.albumsById(['album', 'album', 'missing'], {
        folderId: 'lib',
      }),
      [album],
    );
    assertEquals(
      await t.domain.albumsById(['album'], { folderId: 'missing' }),
      [],
    );
    assertEquals((await t.domain.getAlbum('album'))?.album, album);
    assertEquals(await t.domain.getAlbum('missing'), null);
  } finally {
    await t.close();
  }
});

Deno.test('store.catalog song, search, genre and path families preserve nulls and convert numeric fields', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    await t.run(
      "UPDATE files SET title = 'Song', path = '/song.mp4', genre = 'Jazz', year = 2001, size = 321, duration_ms = 1200, is_video = true WHERE id = 'song'",
    );
    const song = (await t.domain.getSong('song'))!;
    assertEquals(song.size, 321);
    assertEquals(song.durationMs, 1200);
    assertEquals(song.firstSeenMs, null);
    assertEquals(song.contentType, 'video/mp4');
    assertEquals(await t.domain.getSong('missing'), null);
    assertEquals(await t.domain.videos(), [song]);
    assertEquals(await t.domain.listSongs({ offset: 0, size: 10 }), [song]);
    assertEquals(
      await t.domain.randomSongs({
        size: 10,
        genre: 'Jazz',
        fromYear: 2001,
        toYear: 2001,
      }),
      [song],
    );
    assertEquals(await t.domain.randomSongs(1), [song]);
    assertEquals(await t.domain.randomSongs({ size: 10, fromYear: 2002 }), []);
    assertEquals(await t.domain.listGenres(), [{
      name: 'Jazz',
      songCount: 1,
      albumCount: 1,
    }]);
    assertEquals(await t.domain.songsByGenre('Jazz', { offset: 0, size: 10 }), [
      song,
    ]);
    const found = await t.domain.search3('', {
      artistCount: 10,
      artistOffset: 0,
      albumCount: 10,
      albumOffset: 0,
      songCount: 10,
      songOffset: 0,
    });
    assertEquals(found.songs, [song]);
    assertEquals(found.artists.length, 1);
    assertEquals(found.albums.length, 1);
    assertEquals(await t.domain.songPath('song'), '/song.mp4');
    assertEquals(await t.domain.songForLyrics({ artist: 'Artist' }), song);
    assertEquals(await t.domain.songForLyrics({}), null);
    assertEquals(await t.domain.coverSongPath('album'), '/song.mp4');
    assertEquals(await t.domain.coverSongPath('song'), '/song.mp4');
    assertEquals(await t.domain.coverSongPath('missing'), null);
    assertEquals(await t.domain.albumSongPath('album'), '/song.mp4');
    assertEquals(await t.domain.albumSongPath('song'), null);
    assert(JSON.stringify(found).length > 0);
  } finally {
    await t.close();
  }
});
