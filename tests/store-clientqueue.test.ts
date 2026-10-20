import { assert, assertEquals, assertRejects } from '@std/assert';
import { createClientQueueStore } from '../src/store/clientqueue.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('store.clientQueue.get returns plain arrays, index and position defaults', async () => {
  const t = await domainFixture(createClientQueueStore);
  try {
    assertEquals(await t.domain.get('alice'), null);
    await t.run("INSERT INTO files (id, path) VALUES ('song''', '/quoted')");
    await t.domain.save('alice', { trackIds: ['song', "song'", 'song'] });
    const row = await t.domain.get('alice');
    assert(row);
    assertEquals(row.trackIds, ['song', "song'", 'song']);
    assertEquals([row.currentIndex, row.positionMs, row.changedBy], [
      0,
      0,
      null,
    ]);
    assert(Number.isFinite(row.changedAtMs));
    assertEquals(await t.domain.get('bob'), null);
    await assertRejects(() => t.domain.get('unknown'), Error, 'unknown user');
  } finally {
    await t.close();
  }
});

Deno.test('store.clientQueue.save replaces atomically and retains the previous queue on failure', async () => {
  const t = await domainFixture(createClientQueueStore);
  try {
    await t.domain.save('alice', {
      trackIds: ['song'],
      currentIndex: 0,
      positionMs: 12.9,
      changedBy: "phone'",
    });
    const before = await t.domain.get('alice');
    assertEquals(before?.positionMs, 12);
    t.failCommit();
    await assertRejects(
      () => t.domain.save('alice', { trackIds: [] }),
      Error,
      'injected',
    );
    assertEquals(await t.domain.get('alice'), before);
    await t.domain.save('alice', { trackIds: [] });
    assertEquals(await t.domain.get('alice'), null);
  } finally {
    await t.close();
  }
});
