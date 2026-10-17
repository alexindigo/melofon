import { assert, assertEquals } from '@std/assert';
import { openEngine } from '../src/store/engine.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { scanLibrary } from '../src/scan.ts';
import { createLibrary } from '../src/library.ts';
import { stableId } from '../src/albums.ts';
import { tagged } from './helpers/tagged.ts';

Deno.test('album upgrade: verbatim BASE schema retains old album id by COALESCE and all kept rows', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-album-upgrade-' });
  const root = `${dir}/music`;
  await Deno.mkdir(`${root}/Album`, { recursive: true });
  const path = `${root}/Album/a.mp3`;
  await tagged(path, {
    TIT2: 'Song',
    TALB: 'Album',
    TPE1: 'Artist',
    TPE2: 'Artist',
  });
  const albumId = await stableId('album', 'Artist\nAlbum');
  const songId = await stableId('file', 'lib\nAlbum/a.mp3');
  const artistId = await stableId('artist', 'Artist');
  const fixture = await Deno.readTextFile(
    'tests/fixtures/schema-pre-album-identity.sql',
  );
  const engine = await openEngine(`${dir}/db`);
  try {
    // Recreate the old database entirely through the store engine, with no
    // production API for skipping schema initialization and no driver import.
    await engine.exclusive(async (q) => {
      for (
        const row of await q.all<{ table_name: string }>(
          "SELECT table_name FROM duckdb_tables() WHERE schema_name = 'main'",
        )
      ) {
        await q.run(`DROP TABLE "${row.table_name}"`);
      }
      for (
        const row of await q.all<{ sequence_name: string }>(
          "SELECT sequence_name FROM duckdb_sequences() WHERE schema_name = 'main'",
        )
      ) {
        await q.run(`DROP SEQUENCE "${row.sequence_name}"`);
      }
      for (const statement of fixture.split(';')) {
        if (statement.trim()) await q.run(statement);
      }
      const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
      await q.run(
        `INSERT INTO libraries VALUES ('lib', 'Music', ${quote(root)})`,
      );
      await q.run(`INSERT INTO artists VALUES ('${artistId}', 'Artist')`);
      await q.run(
        `INSERT INTO albums VALUES ('${albumId}', 'Album', '${artistId}')`,
      );
      await q.run(
        `INSERT INTO files (id, path, library_id, title, album_id, artist_id) VALUES ('${songId}', ${
          quote(path)
        }, 'lib', 'Song', '${albumId}', '${artistId}')`,
      );
      await q.run(
        `INSERT INTO file_identity (id, library_id, rel_path, present, first_seen_at, last_seen_at) VALUES ('${songId}', 'lib', 'Album/a.mp3', true, epoch_ms(1000), epoch_ms(1000))`,
      );
      await q.run(
        "INSERT INTO users VALUES ('u', 'alice', 'encrypted', now())",
      );
      await q.run(
        `INSERT INTO star_events (user_id, target_id, target_type, action, occurred_at) VALUES ('u', '${albumId}', 'album', 'star', now())`,
      );
      await q.run(
        `INSERT INTO listens VALUES ('u', '${songId}', now(), 123, 'test')`,
      );
      await q.run(`INSERT INTO ratings VALUES ('u', '${albumId}', 5)`);
      await q.run(
        "INSERT INTO playlists VALUES ('p', 'u', 'Mix', NULL, now(), now())",
      );
      await q.run(`INSERT INTO playlist_tracks VALUES ('p', 0, '${songId}')`);
      await q.run(
        `INSERT INTO file_events (occurred_at, kind, file_id) VALUES (now(), 'linked', '${songId}')`,
      );
      assertEquals(
        await q.all(
          "SELECT column_name FROM information_schema.columns WHERE table_name='file_identity' AND column_name='album_id'",
        ),
        [],
      );
      assertEquals(
        await q.all(
          "SELECT table_name FROM information_schema.tables WHERE table_name='album_identity'",
        ),
        [],
      );
    });
  } finally {
    await engine.close();
  }
  const store = await openStore(`${dir}/db`);
  try {
    const kept = [
      'users',
      'listens',
      'ratings',
      'star_events',
      'playlists',
      'playlist_tracks',
      'file_events',
    ];
    const before = await Promise.all(
      kept.map((t) => rawSql(store).all(`SELECT * FROM ${t}`)),
    );
    assertEquals((await store.catalog.identitySnapshot())[0].album_id, albumId);
    assertEquals(
      await rawSql(store).all('SELECT album_id FROM file_identity'),
      [{ album_id: null }],
    );
    await scanLibrary(store);
    const got = await createLibrary(store).getAlbum(albumId);
    assert(got !== null);
    assertEquals([got.album.id, got.album.artistKind, got.album.createdAtMs], [
      albumId,
      'tagged',
      1000,
    ]);
    assertEquals(got.songs.map((s) => s.id), [songId]);
    assertEquals(
      await rawSql(store).all('SELECT album_id FROM file_identity'),
      [{ album_id: albumId }],
    );
    assertEquals(
      await Promise.all(
        kept.map((t) => rawSql(store).all(`SELECT * FROM ${t}`)),
      ),
      before,
    );
    assertEquals(
      (await store.annotations.starred('alice'))[0].targetId,
      albumId,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
