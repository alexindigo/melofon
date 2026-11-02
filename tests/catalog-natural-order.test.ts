import { assertEquals } from '@std/assert';
import { sortKeySql } from '../src/store/catalog-sql.ts';
import { createCatalogStore } from '../src/store/catalog.ts';
import { esc } from '../src/store/engine.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('natural key: folded numeric tokens, arbitrary precision, zero ties and both directions', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    const samples: [string, string | null][] = [
      ['null', null],
      ['empty', ''],
      ['zero-a', '0'],
      ['zero-b', '000'],
      ['two-a', '02'],
      ['two-b', '2'],
      ['ten', '10'],
      ['punctuation', '-2'],
      ['prefix', 'Épisode'],
      ['one', 'episode 1'],
      ['tie-a', 'Épisode 02'],
      ['tie-b', 'EPISODE 2'],
      ['part-two', 'episode 2 part 2'],
      ['part-ten', 'episode 2 part 10'],
      ['three', 'The Episode 3'],
      ['text-ten', 'episode 10'],
      ['huge-nine', `episode ${'9'.repeat(150)}`],
      ['huge-ten', `episode 1${'0'.repeat(150)}`],
      ['cyrillic-two', 'Я 2'],
      ['cyrillic-ten', 'я 10'],
      ['non-ascii-digit', '２'],
    ];
    const expected = [
      'empty',
      'zero-a',
      'zero-b',
      'two-a',
      'two-b',
      'ten',
      'punctuation',
      'prefix',
      'one',
      'tie-a',
      'tie-b',
      'part-two',
      'part-ten',
      'three',
      'text-ten',
      'huge-nine',
      'huge-ten',
      'cyrillic-two',
      'cyrillic-ten',
      'non-ascii-digit',
      'null',
    ];
    const values = samples.map(([id, text]) =>
      `(${esc(id)}, ${text === null ? 'NULL' : esc(text)})`
    ).join(',');
    const key = sortKeySql('name', ['The'], undefined, true);
    for (const direction of ['ASC', 'DESC']) {
      const rows = await t.all<{ id: string }>(
        `WITH samples(id, name) AS (VALUES ${values}) SELECT id FROM samples ORDER BY ${key} ${direction} NULLS LAST, id`,
      );
      // Descending reverses keys, not identity ties; NULL remains explicitly last.
      const descending = [
        'non-ascii-digit',
        'cyrillic-ten',
        'cyrillic-two',
        'huge-ten',
        'huge-nine',
        'text-ten',
        'three',
        'part-ten',
        'part-two',
        'tie-a',
        'tie-b',
        'one',
        'prefix',
        'punctuation',
        'ten',
        'two-a',
        'two-b',
        'zero-a',
        'zero-b',
        'empty',
        'null',
      ];
      assertEquals(
        rows.map((r) => r.id),
        direction === 'ASC' ? expected : descending,
      );
    }
    // Natural alone implies folding, without stripping an article by default.
    const unstripped = await t.all<{ id: string }>(
      `WITH samples(id, name) AS (VALUES ('a', 'é 10'), ('b', 'E 2'), ('c', 'The E 1'))
       SELECT id FROM samples ORDER BY ${
        sortKeySql('name', undefined, undefined, true)
      }, id`,
    );
    assertEquals(unstripped.map((r) => r.id), ['b', 'a', 'c']);
  } finally {
    await t.close();
  }
});

Deno.test('natural catalog: shared keys precede every bounded read and preserve default binary order', async () => {
  const t = await domainFixture(createCatalogStore);
  try {
    await t.run('DELETE FROM files');
    await t.run('DELETE FROM albums');
    await t.run('DELETE FROM artists');
    for (
      const [id, name] of [['a', 'Épisode 10'], ['b', 'episode 2'], [
        'c',
        'EPISODE 02',
      ]]
    ) {
      await t.run(
        `INSERT INTO artists (id, name) VALUES (${esc(id)}, ${esc(name)})`,
      );
      await t.run(
        `INSERT INTO albums (id, name, album_artist_id, artist_kind, folder_name) VALUES (${
          esc(id)
        }, ${esc(name)}, ${esc(id)}, 'tagged', 'folder')`,
      );
      await t.run(
        `INSERT INTO files (id, path, title, album_id, artist_id, genre, year, is_video) VALUES (${
          esc(id)
        }, ${esc('/' + id + '.mp3')}, ${esc(name)}, ${esc(id)}, ${esc(id)}, ${
          esc(name)
        }, 2000, true)`,
      );
    }
    const opts = { natural: true, offset: 0, limit: 20 };
    const ids = (rows: { id: string | null }[]) => rows.map((r) => r.id);
    const wanted = ['b', 'c', 'a'];
    assertEquals(ids((await t.domain.artistsPage(opts)).rows), wanted);
    assertEquals(ids(await t.domain.listArtists(undefined, opts)), wanted);
    assertEquals(
      (await t.domain.listArtists(undefined, opts)).map((r) => r.sortKey),
      ['episode 2', 'episode 02', 'episode 10'],
    );
    for (const sort of ['name', 'artist', 'year', 'genre'] as const) {
      const query = { ...opts, sort };
      assertEquals(ids((await t.domain.albumsPage(query)).rows), wanted);
      assertEquals(ids((await t.domain.songsPage(query)).rows), wanted);
    }
    assertEquals(ids((await t.domain.videosPage(opts)).rows), wanted);
    assertEquals((await t.domain.genresPage(opts)).rows.map((r) => r.name), [
      'EPISODE 02',
      'episode 2',
      'Épisode 10',
    ]);
    const pages = { artists: opts, albums: opts, songs: opts };
    const found = await t.domain.searchPages('', { ...opts, ...pages });
    for (const category of ['artists', 'albums', 'songs'] as const) {
      assertEquals(ids(found[category].rows), wanted);
      assertEquals(found[category].total, 3);
    }
    const old = {
      artistCount: 20,
      artistOffset: 0,
      albumCount: 20,
      albumOffset: 0,
      songCount: 20,
      songOffset: 0,
    };
    const search = await t.domain.search3('', { ...old, natural: true });
    assertEquals(ids(search.artists), wanted);
    assertEquals(ids(search.albums), wanted);
    assertEquals(ids(search.songs), wanted);
    for (let offset = 0; offset <= wanted.length; offset++) {
      const page = await t.domain.songsPage({
        ...opts,
        sort: 'name',
        limit: 1,
        offset,
      });
      assertEquals(ids(page.rows), wanted.slice(offset, offset + 1));
      assertEquals(page.total, 3);
    }
    assertEquals(
      ids(
        (await t.domain.songsPage({ sort: 'name', offset: 0, limit: 20 })).rows,
      ),
      ['c', 'b', 'a'],
    );
    assertEquals(
      ids(
        (await t.domain.songsPage({ ...opts, natural: false, sort: 'name' }))
          .rows,
      ),
      ['c', 'b', 'a'],
    );
  } finally {
    await t.close();
  }
});
