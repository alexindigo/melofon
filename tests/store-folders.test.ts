import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { createFolders } from '../src/folders.ts';
import { createFoldersStore } from '../src/store/folders.ts';
import { createCatalogStore } from '../src/store/catalog.ts';
import { rawSql } from '../src/store/testing.ts';
import { LibraryError } from '../src/library-errors.ts';
import { domainFixture } from './helpers/store.ts';

const options = {
  folders: { offset: 0, limit: 50 },
  songs: { offset: 0, limit: 50 },
};

Deno.test('store.folders: literal path ancestry, root slash, safe membership and persisted offline pages', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-store-folders-' });
  let store = await openStore(dir);
  try {
    await store.catalog.addLibrary({
      id: 'music',
      name: 'Music',
      path: '/music🚀',
    });
    await rawSql(store).run(`INSERT INTO files (id, path, library_id) VALUES
      ('root', '/music🚀/root.mp3', 'music'),
      ('nested', '/music🚀/a%_🚀/deep/file.mp3', 'music'),
      ('lookalike', '/music🚀/abc/deep/file.mp3', 'music'),
      ('sibling', '/music🚀-sibling/secret.mp3', 'music'),
      ('escape', '/music🚀/../secret.mp3', 'music'),
      ('dot', '/music🚀/a/./file.mp3', 'music'),
      ('double', '/music🚀/a//file.mp3', 'music'),
      ('unresolved', '/music🚀/lost/file.mp3', NULL)`);
    const read = () =>
      createFolders(store).browse({
        ...options,
        libraryId: 'music',
        ignoredArticles: [],
      });
    const before = await read();
    assertEquals(before.folders.rows.map((r) => r.path), ['a%_🚀', 'abc']);
    assertEquals(before.songs.rows.map((r) => r.id), ['root']);
    assertEquals([before.folders.total, before.songs.total], [2, 1]);
    const deep = await createFolders(store).browse({
      ...options,
      libraryId: 'music',
      path: 'a%_🚀/deep',
    });
    assertEquals(deep.songs.rows.map((r) => r.id), ['nested']);
    await store.close();
    store = await openStore(dir);
    assertEquals(await read(), before);
    assertEquals(
      await createFolders(store).browse({
        ...options,
        libraryId: 'music',
        path: 'a%_🚀/deep',
      }),
      deep,
    );
    await store.catalog.removeLibrary('music');
    await store.catalog.addLibrary({
      id: 'slash',
      name: 'Filesystem root',
      path: '/',
    });
    await rawSql(store).run(
      "INSERT INTO files (id, path, library_id) VALUES ('one', '/one.mp3', 'slash'), ('two', '/dir/two.mp3', 'slash')",
    );
    const slash = await createFolders(store).browse({
      ...options,
      libraryId: 'slash',
    });
    assertEquals(slash.folders.rows.map((r) => r.path), ['dir']);
    assertEquals(slash.songs.rows.map((r) => r.id), ['one']);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store.folders: root and scoped facts, both totals/pages and revision share one exclusive snapshot', async () => {
  let pause: ((sql: string) => Promise<void>) | undefined;
  const t = await domainFixture((engine) => ({
    catalog: createCatalogStore(engine),
    folders: createFoldersStore({
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
    }),
  }));
  try {
    for (const scoped of [false, true]) {
      await t.domain.catalog.addLibrary({
        id: 'lib',
        name: 'Music',
        path: '/music',
      });
      await t.run(
        "INSERT INTO files (id, path, library_id) VALUES ('nested', '/music/Dir/song.mp3', 'lib'), ('immediate', '/music/root.mp3', 'lib')",
      );
      const read = () =>
        t.domain.folders.browse({
          ...options,
          ...(scoped ? { libraryId: 'lib' } : {}),
        });
      const before = await read();
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const hold = new Promise<void>((r) => {
        release = r;
      });
      pause = async (sql) => {
        if (sql.includes('AS total FROM (')) {
          enter();
          await hold;
        }
      };
      const pending = read();
      try {
        await entered;
        const write = t.domain.catalog.removeLibrary('lib');
        pause = undefined;
        release();
        assertEquals(await pending, before);
        await write;
        if (scoped) {
          await assertRejects(read, LibraryError, 'Library not found');
        }
        const after = await t.domain.folders.browse(options);
        assertEquals([after.folders.total, after.songs.total], [0, 0]);
        assertNotEquals(after.revision, before.revision);
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

Deno.test('core.folders: indexed ancestry and opening agree on every forbidden control and legacy path', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-folder-contract-' });
  const store = await openStore(dir);
  try {
    await store.catalog.addLibrary({
      id: 'lib',
      name: 'Music',
      path: '/music',
    });
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const valid = ['a', 'a/X:Y', 'a/1:ok', "quote'%_", '日本語'];
    const invalid = [
      '.',
      '..',
      '/bad',
      'a/',
      'a/.',
      'a/..',
      'a//b',
      'a\\b',
      'a/b\\c',
      'X:Y',
      'z:drive',
    ];
    const entries = [
      ...valid.map((path) => ({ path, sql: quote(path) })),
      ...invalid.map((path) => ({ path, sql: quote(path) })),
      ...[...Array.from({ length: 32 }, (_, i) => i), 127].flatMap((code) =>
        ['', 'a/'].map((prefix) => ({
          path: `${prefix}bad${String.fromCharCode(code)}name`,
          sql: `${quote(prefix + 'bad')} || chr(${code}) || 'name'`,
        }))
      ),
    ];
    for (const [i, entry] of entries.entries()) {
      await rawSql(store).run(`INSERT INTO files (id, path, library_id) VALUES
        ('file-${i}', '/music/' || ${entry.sql} || '/song.mp3', 'lib')`);
    }
    const folders = createFolders(store);
    const read = (path: string) =>
      folders.browse({ ...options, libraryId: 'lib', path });
    const root = await read('');
    assertEquals(root.folders.rows.map((r) => r.path), [
      'a',
      "quote'%_",
      '日本語',
    ]);
    assertEquals(root.folders.total, 3);
    assertEquals((await read('a')).folders.rows.map((r) => r.path), [
      'a/1:ok',
      'a/X:Y',
    ]);
    for (const path of valid) assertEquals((await read(path)).songs.total, 1);
    for (const { path } of entries.slice(valid.length)) {
      await assertRejects(
        async () => await read(path),
        LibraryError,
        'Invalid folder path',
      );
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('core.folders: canonical relative addresses and safe integer paging are required before store reads', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-folder-input-' });
  const store = await openStore(dir);
  try {
    const folders = createFolders(store);
    for (
      const path of [
        '../x',
        '/x',
        'x/..',
        'x//y',
        'x/',
        'x\\y',
        'C:/x',
        'bad\0',
        '.',
      ]
    ) {
      await assertRejects(
        async () =>
          await folders.browse({ ...options, libraryId: 'lib', path }),
        LibraryError,
        'Invalid folder path',
      );
    }
    await assertRejects(
      async () => await folders.browse({ ...options, path: 'x' }),
      LibraryError,
      'Invalid folder path',
    );
    for (
      const page of [{ offset: -1, limit: 1 }, { offset: 0, limit: 0 }, {
        offset: 0.5,
        limit: 2,
      }, { offset: 0, limit: Infinity }]
    ) {
      await assertRejects(
        async () => await folders.browse({ ...options, folders: page }),
        LibraryError,
        'Invalid folder page',
      );
      await assertRejects(
        async () => await folders.browse({ ...options, songs: page }),
        LibraryError,
        'Invalid folder page',
      );
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
