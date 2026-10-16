import { assert, assertEquals, assertRejects } from '@std/assert';
import { createBookmarksStore } from '../src/store/bookmarks.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('store.bookmarks.list resolves and isolates users with plain millisecond values', async () => {
  const t = await domainFixture(createBookmarksStore);
  try {
    await t.domain.set('alice', 'song', 21, 'note');
    assertEquals(await t.domain.list('bob'), []);
    const [row] = await t.domain.list('alice');
    assertEquals([row.trackId, row.positionMs, row.comment], [
      'song',
      21,
      'note',
    ]);
    assert(
      Number.isFinite(row.createdAtMs) && Number.isFinite(row.changedAtMs),
    );
    await assertRejects(() => t.domain.list('unknown'), Error, 'unknown user');
  } finally {
    await t.close();
  }
});

Deno.test('store.bookmarks.set preserves creation date and rolls back failed updates', async () => {
  const t = await domainFixture(createBookmarksStore);
  try {
    await t.domain.set('alice', "song'", 21.9, "note'");
    const before = await t.domain.list('alice');
    t.failCommit();
    await assertRejects(
      () => t.domain.set('alice', "song'", 99),
      Error,
      'injected',
    );
    assertEquals(await t.domain.list('alice'), before);
    await t.domain.set('alice', "song'", 42);
    const [after] = await t.domain.list('alice');
    assertEquals(after.createdAtMs, before[0].createdAtMs);
    assertEquals([after.positionMs, after.comment], [42, null]);
  } finally {
    await t.close();
  }
});

Deno.test('store.bookmarks.remove rolls back failed deletion and leaves other users intact', async () => {
  const t = await domainFixture(createBookmarksStore);
  try {
    await t.domain.set('alice', 'song', 1);
    await t.domain.set('bob', 'song', 2);
    t.failCommit();
    await assertRejects(
      () => t.domain.remove('alice', 'song'),
      Error,
      'injected',
    );
    assertEquals((await t.domain.list('alice')).length, 1);
    await t.domain.remove('alice', 'song');
    assertEquals(await t.domain.list('alice'), []);
    assertEquals((await t.domain.list('bob')).length, 1);
  } finally {
    await t.close();
  }
});
