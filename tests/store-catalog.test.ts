import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from '@std/assert';
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
import { rawSql } from '../src/store/testing.ts';

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
    albums: [{
      id: 'album',
      name: "Album'",
      albumArtistId: 'artist',
      artistName: "Artist'",
      artistKind: 'tagged',
      folderName: 'Music',
      libraryId: 'lib',
      rootDir: '',
    }],
    albumIdentities: [{ id: 'album', libraryId: 'lib', rootDir: '' }],
    albumEvents: [],
    files: [file],
    events: [],
    retainedIds: [],
  };
}

Deno.test('store.catalog revision upgrades existing catalogs, persists across reopen and differs between databases', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-revision-upgrade-' });
  const otherDir = await Deno.makeTempDir({
    prefix: 'melofon-revision-other-',
  });
  let store = await openStore(dir);
  try {
    await store.catalog.addLibrary({
      id: 'lib',
      name: 'Music',
      path: '/music',
    });
    await store.catalog.replaceCatalog(snapshot());
    const song = await store.catalog.getSong('song');
    // Simulate an installed pre-revision schema while retaining its real catalog.
    await rawSql(store).run('DROP TABLE catalog_revision');
    await store.close();
    store = await openStore(dir);
    const upgraded = await store.catalog.getSongSnapshot('song');
    assertEquals(upgraded.song, song);
    assert(/^[0-9a-f-]{36}:0$/.test(upgraded.revision));
    assertEquals(
      (await store.catalog.librariesSnapshot()).revision,
      upgraded.revision,
    );
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.catalog.getSongSnapshot('song'), upgraded);
    const other = await openStore(otherDir);
    try {
      assertNotEquals(
        (await other.catalog.librariesSnapshot()).revision,
        upgraded.revision,
      );
    } finally {
      await other.close();
    }
    await store.catalog.replaceCatalog({
      ...snapshot(),
      retainedIds: ['song'],
    });
    const advanced = await store.catalog.getSongSnapshot('song');
    assertEquals(advanced.revision, upgraded.revision.replace(/:0$/, ':1'));
    await store.close();
    store = await openStore(dir);
    assertEquals(await store.catalog.getSongSnapshot('song'), advanced);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(otherDir, { recursive: true });
  }
});

Deno.test('store.catalog revision advances only on committed publications and source mutations', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    const before = await t.domain.getSongSnapshot('song');
    const initial = await t.domain.librariesSnapshot();
    for (
      const operation of [
        () =>
          t.domain.addLibrary({ id: 'extra', name: 'Extra', path: '/extra' }),
        () => t.domain.replaceCatalog(snapshot()),
      ]
    ) {
      t.failCommit();
      await assertRejects(operation, Error, 'injected commit failure');
      assertEquals(await t.domain.getSongSnapshot('song'), before);
      assertEquals(await t.domain.librariesSnapshot(), initial);
    }
    await t.domain.addLibrary({ id: 'lib', name: 'Music', path: '/music' });
    let prior = await t.domain.librariesSnapshot();
    assertNotEquals(prior.revision, initial.revision);
    for (
      const operation of [
        () => t.domain.updateLibrary('lib', { name: 'Changed' }),
        () => t.domain.removeLibrary('lib'),
      ]
    ) {
      t.failCommit();
      await assertRejects(operation, Error, 'injected commit failure');
      assertEquals(await t.domain.librariesSnapshot(), prior);
    }
    for (
      const operation of [
        () => t.domain.updateLibrary('lib', { name: 'Changed' }),
        () => t.domain.replaceCatalog(snapshot()),
        () => t.domain.removeLibrary('lib'),
      ]
    ) {
      await operation();
      const next = await t.domain.librariesSnapshot();
      const [epoch, count] = prior.revision.split(':');
      assertEquals(next.revision, `${epoch}:${Number(count) + 1}`);
      prior = next;
    }
    assertEquals(await t.domain.removeLibrary('missing'), false);
    await assertRejects(() =>
      t.domain.updateLibrary('missing', { name: 'Missing' })
    );
    assertEquals(await t.domain.librariesSnapshot(), prior);
  } finally {
    await t.close();
  }
});

Deno.test('store.catalog song and source snapshots cannot pair old facts with a queued mutation revision', async () => {
  let pause: ((sql: string) => Promise<void>) | undefined;
  const t = await domainFixture((engine) =>
    createCatalogStore({
      ...engine,
      exclusive: (fn) =>
        engine.exclusive((q) =>
          fn({
            ...q,
            async all<T>(sql: string): Promise<T[]> {
              const rows = await q.all<T>(sql);
              await pause?.(sql);
              return rows;
            },
          })
        ),
    })
  );
  try {
    await t.domain.addLibrary({ id: 'lib', name: 'Music', path: '/music' });
    for (const kind of ['song', 'sources'] as const) {
      const read = () =>
        kind === 'song'
          ? t.domain.getSongSnapshot('song')
          : t.domain.librariesSnapshot();
      const before = await read();
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      pause = async (sql) => {
        if (
          (kind === 'song' && sql.includes('WHERE f.id')) ||
          (kind === 'sources' && sql.includes('SELECT l.id'))
        ) {
          entered();
          await held;
        }
      };
      const pending = read();
      try {
        await waiting;
        const write = t.domain.updateLibrary('lib', { name: kind });
        pause = undefined;
        release();
        assertEquals(await pending, before);
        await write;
        assertNotEquals((await read()).revision, before.revision);
      } finally {
        pause = undefined;
        release();
        await pending;
      }
    }
  } finally {
    await t.close();
  }
});

Deno.test('store.catalog album page counts/rows and detail children share their revision snapshot', async () => {
  let pause: ((sql: string) => Promise<void>) | undefined;
  const t = await domainFixture((engine) =>
    createCatalogStore({
      ...engine,
      exclusive: (fn) =>
        engine.exclusive((q) =>
          fn({
            ...q,
            async all<T>(sql: string): Promise<T[]> {
              const rows = await q.all<T>(sql);
              await pause?.(sql);
              return rows;
            },
          })
        ),
    })
  );
  try {
    await t.domain.addLibrary({ id: 'lib', name: 'Music', path: '/music' });
    for (const kind of ['page', 'detail'] as const) {
      await t.domain.replaceCatalog({
        ...snapshot(),
        retainedIds: kind === 'page' ? [] : ['song'],
      });
      const read = () =>
        kind === 'page'
          ? t.domain.albumsPage({
            sort: 'name',
            limit: 1,
            offset: 0,
            folderId: 'lib',
          })
          : t.domain.getAlbumSnapshot('album', 'lib');
      const before = await read();
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      pause = async (sql) => {
        if (
          (kind === 'page' && sql.includes('SELECT COUNT(*) AS total')) ||
          (kind === 'detail' && sql.includes('HAVING al.id'))
        ) {
          entered();
          await held;
        }
      };
      const pending = read();
      try {
        await waiting;
        const write = t.domain.replaceCatalog({
          artists: [],
          albums: [],
          files: [],
          albumIdentities: [],
          albumEvents: [],
          events: [],
          retainedIds: [],
        });
        pause = undefined;
        release();
        assertEquals(await pending, before);
        await write;
        const after = await read();
        assertNotEquals(after.revision, before.revision);
        if ('rows' in after) {
          assertEquals(after.rows, []);
          assertEquals(after.total, 0);
        } else assertEquals(after.detail, null);
      } finally {
        pause = undefined;
        release();
        await pending;
      }
    }
  } finally {
    await t.close();
  }
});

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
      album_id: 'album',
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
      albumIdentities: [],
      albumEvents: [],
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
      'album_identity',
      'album_events',
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
    next.albumEvents.push({
      kind: 'unlinked',
      albumId: 'prior',
      candidates: ['album'],
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
    await createLibraries(store).add(
      'Music',
      await Deno.realPath('tests/fixtures/library'),
    );
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
          return await store.catalog.replaceCatalog(JSON.parse(serialized));
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

Deno.test('store.catalog libraries add atomically, reject concurrent duplicate paths and list by name', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    const row = { id: "lib'", name: "Z'", path: "/music'" };
    const results = await Promise.allSettled([
      t.domain.addLibrary(row),
      t.domain.addLibrary({ ...row, id: 'other', name: 'Other' }),
    ]);
    assertEquals(results[0], {
      status: 'fulfilled',
      value: { ...row, available: true },
    });
    assertEquals(results[1].status, 'rejected');
    if (results[1].status === 'rejected') {
      assertEquals(results[1].reason.code, 'path_duplicate');
    }
    const first = { id: 'first', name: 'A', path: '/first' };
    t.failCommit();
    await assertRejects(
      () => t.domain.addLibrary(first),
      Error,
      'injected commit failure',
    );
    assertEquals(await t.domain.listLibraries(), [{ ...row, available: true }]);
    await t.domain.addLibrary(first);
    assertEquals(
      await t.domain.listLibraries(),
      [first, row].map((r) => ({ ...r, available: true })),
    );
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
    await t.run(
      "INSERT INTO artists (id, name) VALUES ('performer', 'Performer')",
    );
    assertEquals(await t.domain.listArtists(), [{
      id: 'artist',
      name: 'Artist',
      musicBrainzId: null,
      albumCount: 1,
    }]);
    assertEquals(await t.domain.listArtists('missing'), []);
    assertEquals(await t.domain.getArtist('performer'), null);
    assertEquals(await t.domain.artistById('performer'), {
      id: 'performer',
      name: 'Performer',
      musicBrainzId: null,
      albumCount: 0,
    });
    const album = {
      id: 'album',
      name: 'Album',
      artistId: 'artist',
      artistName: 'Artist',
      artistKind: 'tagged' as const,
      folderName: 'Music',
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

Deno.test('store.catalog artistless albums survive every album read with plain folder facts and scoped totals', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    const next = snapshot();
    next.artists = [];
    next.albums = [
      {
        ...next.albums[0],
        id: 'various',
        name: null,
        albumArtistId: null,
        artistName: null,
        artistKind: 'various',
        folderName: 'The Singles',
      },
      {
        ...next.albums[0],
        id: 'unknown',
        name: null,
        albumArtistId: null,
        artistName: null,
        artistKind: 'unknown',
        folderName: 'Mystery',
        libraryId: 'other',
      },
    ];
    next.files = next.albums.map((a, i) => ({
      ...next.files[0],
      id: `s${i}`,
      albumId: a.id,
      artistId: null,
      libraryId: a.libraryId,
      path: `/music/${i}.mp3`,
      rel: `${i}.mp3`,
    }));
    next.albumIdentities = next.albums.map(({ id, libraryId, rootDir }) => ({
      id,
      libraryId,
      rootDir,
    }));
    await t.domain.replaceCatalog(next);
    const all = await t.domain.listAlbums({
      sort: 'name',
      size: 10,
      offset: 0,
    });
    assertEquals(
      all.map((
        a,
      ) => [
        a.id,
        a.name,
        a.artistId,
        a.artistName,
        a.artistKind,
        a.folderName,
      ]),
      [['unknown', null, null, null, 'unknown', 'Mystery'], [
        'various',
        null,
        null,
        null,
        'various',
        'The Singles',
      ]],
    );
    assertEquals(await t.domain.albumsWithoutArtist('various'), [all[1]]);
    assertEquals(await t.domain.albumsWithoutArtist('unknown'), [all[0]]);
    assertEquals(
      await t.domain.albumsWithoutArtist('various', { folderId: 'other' }),
      [],
    );
    assertEquals(
      await t.domain.albumsWithoutArtist('various', { folderId: 'lib' }),
      [all[1]],
    );
    assertEquals(await t.domain.albumsById(['various'], { folderId: 'lib' }), [
      all[1],
    ]);
    const got = (await t.domain.getAlbum('various'))!;
    assertEquals(got.album, all[1]);
    assertEquals(got.songs.map((s) => [s.albumName, s.albumFolderName]), [[
      null,
      'The Singles',
    ]]);
    assertEquals(got.album.songCount, got.songs.length);
    assertEquals(
      got.album.durationMs,
      got.songs.reduce((n, s) => n + (s.durationMs ?? 0), 0),
    );
    const search = await t.domain.search3('Singles', {
      artistCount: 10,
      artistOffset: 0,
      albumCount: 10,
      albumOffset: 0,
      songCount: 10,
      songOffset: 0,
    });
    assertEquals(search.albums, [all[1]]);
    assertEquals(
      (await t.domain.listAlbums({
        sort: 'name',
        size: 10,
        offset: 0,
        ignoredArticles: ['The'],
      })).map((a) => a.id),
      ['unknown', 'various'],
    );
    assertEquals(await t.domain.listArtists(), []);
  } finally {
    await t.close();
  }
});

Deno.test('store.catalog retained album snapshots and append-only events survive absence and library removal', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    await t.domain.addLibrary({ id: 'lib', name: 'Music', path: '/music' });
    const next = snapshot();
    next.albumEvents = [
      {
        kind: 'moved',
        albumId: 'album',
        from: { id: 'album', libraryId: 'lib', rootDir: 'Before' },
        to: next.albumIdentities[0],
      },
      { kind: 'unlinked', albumId: 'prior', candidates: ['album'] },
    ];
    await t.domain.replaceCatalog(next);
    assertEquals(await t.domain.albumIdentitySnapshot(), next.albumIdentities);
    assertEquals((await t.domain.identitySnapshot())[0].album_id, 'album');
    const events = await t.all(
      'SELECT kind, album_id, from_root, to_root, candidates FROM album_events ORDER BY seq',
    );
    assertEquals(events, [
      {
        kind: 'moved',
        album_id: 'album',
        from_root: 'Before',
        to_root: '',
        candidates: [],
      },
      {
        kind: 'unlinked',
        album_id: 'prior',
        from_root: null,
        to_root: null,
        candidates: ['album'],
      },
    ]);
    await t.domain.replaceCatalog({
      artists: [],
      albums: [],
      files: [],
      retainedIds: ['song'],
      events: [],
      albumIdentities: [],
      albumEvents: [],
    });
    assertEquals(await t.all('SELECT present FROM album_identity'), [{
      present: false,
    }]);
    assertEquals((await t.domain.identitySnapshot())[0].album_id, 'album');
    assertEquals(await t.domain.removeLibrary('lib'), true);
    assertEquals(await t.domain.albumIdentitySnapshot(), next.albumIdentities);
    assertEquals(
      await t.all(
        'SELECT kind, album_id, from_root, to_root, candidates FROM album_events ORDER BY seq',
      ),
      events,
    );
  } finally {
    await t.close();
  }
});
