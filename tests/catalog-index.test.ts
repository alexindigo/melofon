import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';
import { createCatalogStore } from '../src/store/catalog.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('catalog index: page, complete index runs, total and revision share one publication snapshot', async () => {
  for (const mode of ['artists', 'albums', 'songs', 'membership'] as const) {
    let pause: (() => Promise<void>) | undefined;
    const t = await domainFixture((engine) =>
      createCatalogStore({
        ...engine,
        exclusive: (fn) =>
          engine.exclusive((q) =>
            fn({
              ...q,
              async all<T>(sql: string): Promise<T[]> {
                const rows = await q.all<T>(sql);
                if (sql.startsWith('WITH ranked AS')) await pause?.();
                return rows;
              },
            })
          ),
      })
    );
    try {
      for (const sort of ['artist', 'year', 'newest', 'random'] as const) {
        await assertRejects(
          () => t.domain.songsPage({ sort, index: true, offset: 0, limit: 1 }),
          Error,
          'Index requires name sort',
        );
        await assertRejects(
          () => t.domain.albumsPage({ sort, index: true, offset: 0, limit: 1 }),
          Error,
          'Index requires name sort',
        );
      }
      const opts = {
        index: true,
        sortTags: true,
        natural: true,
        descending: true,
        ignoredArticles: [],
        offset: 0,
        limit: 1,
      };
      const read = () =>
        mode === 'artists'
          ? t.domain.artistsPage(opts)
          : mode === 'albums'
          ? t.domain.albumsPage({ ...opts, sort: 'name' })
          : mode === 'songs'
          ? t.domain.songsPage({ ...opts, sort: 'name' })
          : t.domain.artistAlbumsPage({ kind: 'artist', id: 'artist' }, opts);
      const before = await read();
      assertEquals(before.total, 1);
      assertEquals(before.index, [{
        kind: 'text',
        initial: mode === 'songs' ? 's' : 'a',
        offset: 0,
        count: 1,
      }]);
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      pause = async () => {
        entered();
        await held;
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
        assertEquals([after.rows, after.index, after.total], [[], [], 0]);
        assertNotEquals(after.revision, before.revision);
      } finally {
        pause = undefined;
        release();
        await pending;
      }
    } finally {
      await t.close();
    }
  }
});
