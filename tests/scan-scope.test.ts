import { assert, assertEquals } from '@std/assert';
import { scanFixture } from './helpers/scans.ts';
import { error } from './helpers/api.ts';
import { rawSql } from '../src/store/testing.ts';

Deno.test('scoped scans: one library preserves other songs, stars, identities and moves', async () => {
  const f = await scanFixture();
  try {
    await f.write('A', 'one/song.mp3', 'A');
    await f.write('B', 'one/song.mp3', 'B');
    const a = await f.add('A');
    await f.add('B');
    await f.scan();
    const before = await f.songs();
    const b = before.find((s: { title: string }) => s.title === 'B');
    await f.rest('star', { id: b.id });
    // Same audio appears in the scanned library, but B was not observed absent.
    await Deno.rename(`${f.root}/B/one/song.mp3`, `${f.root}/A/one/copy.mp3`);
    await f.write('A', 'one/song.mp3', 'Changed A');
    const identity = await f.store.catalog.identitySnapshot();
    const events = await f.store.catalog.events({ limit: 100 });
    const outside = () =>
      Promise.all([
        rawSql(f.store).all(`SELECT * FROM files WHERE id = '${b.id}'`),
        rawSql(f.store).all(`SELECT * FROM file_identity WHERE id = '${b.id}'`),
        rawSql(f.store).all(`SELECT * FROM albums WHERE id = '${b.albumId}'`),
        rawSql(f.store).all(
          `SELECT * FROM album_identity WHERE id = '${b.albumId}'`,
        ),
      ]);
    const outsideBefore = await outside();
    await f.scan({ libraries: [a.id] });
    assertEquals((await f.rest('getSong', { id: b.id })).song.title, 'B');
    assertEquals(
      (await f.rest('getStarred2')).starred2.song.map((s: { id: string }) =>
        s.id
      ),
      [b.id],
    );
    assertEquals(
      (await f.store.catalog.identitySnapshot()).find((r) => r.id === b.id),
      identity.find((r) => r.id === b.id),
    );
    assertEquals(await f.store.catalog.events({ limit: 100 }), events);
    assertEquals(await outside(), outsideBefore);
    assert(
      (await f.songs()).some((s: { title: string }) => s.title === 'Changed A'),
    );
  } finally {
    await f.close();
  }
});

Deno.test('folder scans: changed tags and multipart album use retained facts across the boundary', async () => {
  const f = await scanFixture();
  try {
    await f.write('A', 'Album/CD1/a.mp3', 'One', 1);
    await f.write('A', 'Album/CD2/b.mp3', 'Two', 2);
    await f.write('A', 'Other/c.mp3', 'Other');
    const a = await f.add('A');
    await f.scan();
    const songs = await f.songs();
    const one = songs.find((s: { title: string }) => s.title === 'One');
    const two = songs.find((s: { title: string }) => s.title === 'Two');
    await f.rest('star', { albumId: one.albumId });
    await f.write('A', 'Album/CD1/a.mp3', 'Changed', 1);
    await f.write('A', 'Other/c.mp3', 'Do not read');
    await f.scan({ folder: { library: a.id, path: 'Album/CD1' } });
    const album = (await f.rest('getAlbum', { id: one.albumId })).album;
    assertEquals(album.songCount, 2);
    assertEquals(album.song.map((s: { title: string }) => s.title).sort(), [
      'Changed',
      'Two',
    ]);
    assertEquals(
      (await f.rest('getSong', { id: two.id })).song.albumId,
      one.albumId,
    );
    assertEquals(
      (await f.songs()).find((s: { title: string }) => s.title === 'Other')
        .title,
      'Other',
    );
    assertEquals(
      (await f.rest('getStarred2')).starred2.album[0].id,
      one.albumId,
    );
  } finally {
    await f.close();
  }
});

Deno.test('scan scope API validates ids, mutually exclusive scope and canonical containment', async () => {
  const f = await scanFixture();
  try {
    await f.write('A', 'one/song.mp3', 'A');
    const a = await f.add('A');
    await Deno.mkdir(`${f.root}/outside`);
    await Deno.symlink(`${f.root}/outside`, `${f.root}/A/link`);
    for (
      const [body, status, code] of [
        [{ libraries: ['missing'] }, 404, 'not_found'],
        [{ libraries: 'A' }, 400, 'invalid_field'],
        [{ libraries: [] }, 400, 'invalid_field'],
        [
          { libraries: [a.id], folder: { library: a.id, path: 'one' } },
          400,
          'invalid_field',
        ],
        [
          { folder: { library: a.id, path: '../outside' } },
          400,
          'path_outside_library',
        ],
        [
          { folder: { library: a.id, path: '/absolute' } },
          400,
          'path_outside_library',
        ],
        [
          { folder: { library: a.id, path: 'link' } },
          400,
          'path_outside_library',
        ],
        [{ folder: { library: a.id, path: 'missing' } }, 404, 'not_found'],
      ] as const
    ) {
      await error(
        await f.json('/api/v1/admin/scans', 'POST', body, f.bearer),
        status,
        code,
      );
    }
  } finally {
    await f.close();
  }
});
