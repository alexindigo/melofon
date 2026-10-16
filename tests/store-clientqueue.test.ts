import { assert, assertEquals, assertRejects } from '@std/assert';
import { createClientQueueStore } from '../src/store/clientqueue.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('store.clientQueue.get returns plain arrays and nullable fields', async () => {
  const t = await domainFixture(createClientQueueStore);
  try {
    assertEquals(await t.domain.get('alice'), null);
    await t.domain.save('alice', { trackIds: ['song', "song'", 'song'] });
    const row = await t.domain.get('alice');
    assert(row);
    assertEquals(row.trackIds, ['song', "song'", 'song']);
    assertEquals([row.currentId, row.positionMs, row.changedBy], [
      null,
      null,
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
      currentId: 'song',
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
    assertEquals((await t.domain.get('alice'))?.trackIds, []);
  } finally {
    await t.close();
  }
});
