import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import type { LookupInput } from '../src/store/lookups.ts';

const input = (overrides: Partial<LookupInput> = {}): LookupInput => ({
  plugin: 'fixture',
  entityType: 'album',
  entityId: 'album',
  factsHash: 'facts',
  mode: 'missing',
  ...overrides,
});
async function setup(fn: (store: Store, dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-lookups-' });
  const store = await openStore(dir);
  try {
    await fn(store, dir);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('enqueue dedupes pending and done facts, but changed facts and explicit all queue again', async () => {
  await setup(async (store) => {
    const ids = await store.lookups.enqueue([input(), input()]);
    assertEquals(ids.length, 1);
    const job = await store.lookups.claimNext('fixture');
    assert(job !== null);
    assertEquals([
      job.id,
      job.plugin,
      job.entityType,
      job.entityId,
      job.factsHash,
      job.mode,
      job.state,
      job.attempts,
      job.lastError,
      job.finishedAtMs,
    ], [
      ids[0],
      'fixture',
      'album',
      'album',
      'facts',
      'missing',
      'active',
      1,
      null,
      null,
    ]);
    assert(job.startedAtMs! >= job.queuedAtMs);
    assertEquals(await store.lookups.enqueue([input()]), []);
    await store.lookups.finish(job.id, { state: 'done' });
    assertEquals(await store.lookups.enqueue([input()]), []);
    assertEquals(
      (await store.lookups.enqueue([
        input({ factsHash: 'new' }),
        input({ mode: 'all' }),
      ])).length,
      2,
    );
    assertEquals(await store.lookups.stats('fixture'), {
      waiting: 2,
      active: 0,
      done: 1,
      failed: 0,
    });
  });
});

Deno.test('claimNext is atomic, FIFO and per-plugin under concurrent claims and playback saves', async () => {
  await setup(async (store) => {
    const ids = await store.lookups.enqueue(
      Array.from({ length: 40 }, (_, n) => input({ entityId: `${n}` })),
    );
    await store.lookups.enqueue([input({ plugin: 'other' })]);
    const claims = await Promise.all(
      Array.from({ length: 50 }, async (_, n) => {
        const job = store.lookups.claimNext('fixture');
        await store.playback.saveQueue([`${n}`]);
        return await job;
      }),
    );
    assertEquals(claims.filter((j) => j !== null).map((j) => j!.id), ids);
    assertEquals(
      new Set(claims.filter((j) => j !== null).map((j) => j!.id)).size,
      40,
    );
    assertEquals(await store.playback.loadQueue(), ['49']);
    assertEquals((await store.lookups.claimNext('other'))?.plugin, 'other');
  });
});

Deno.test('finish failure retains error and a new failed-item job can be queued', async () => {
  await setup(async (store) => {
    await store.lookups.enqueue([input()]);
    const job = (await store.lookups.claimNext('fixture'))!;
    await store.lookups.finish(job.id, {
      state: 'failed',
      error: "can't reach fixture",
    });
    assertEquals(await store.lookups.stats('fixture'), {
      waiting: 0,
      active: 0,
      done: 0,
      failed: 1,
    });
    assertEquals((await store.lookups.enqueue([input()])).length, 1);
    await store.lookups.finish(job.id, { state: 'done' });
    assertEquals((await store.lookups.stats('fixture')).failed, 1);
  });
});

Deno.test('waiting finish enforces not-before and retries preserve error and attempts', async () => {
  await setup(async (store) => {
    await store.lookups.enqueue([input()]);
    const job = (await store.lookups.claimNext('fixture'))!;
    await store.lookups.finish(job.id, {
      state: 'waiting',
      notBeforeMs: Date.now() + 3600000,
      error: 'offline',
    });
    assertEquals(await store.lookups.claimNext('fixture'), null);
    // Startup only resets active jobs, never erases a persisted retry delay.
    await store.lookups.resetActive();
    assertEquals(await store.lookups.claimNext('fixture'), null);
    await store.lookups.enqueue([input({ entityId: 'ready' })]);
    assertEquals((await store.lookups.claimNext('fixture'))?.entityId, 'ready');
  });
});

Deno.test('retry claims increment attempts, retry-later does not count as a failed attempt', async () => {
  await setup(async (store) => {
    await store.lookups.enqueue([input()]);
    const first = (await store.lookups.claimNext('fixture'))!;
    await store.lookups.finish(first.id, {
      state: 'waiting',
      notBeforeMs: 0,
      error: 'offline',
    });
    const second = (await store.lookups.claimNext('fixture'))!;
    assertEquals([second.id, second.attempts, second.lastError], [
      first.id,
      2,
      'offline',
    ]);
    await store.lookups.finish(second.id, {
      state: 'waiting',
      notBeforeMs: 0,
      error: 'rate limited',
      countAttempt: false,
    });
    const third = (await store.lookups.claimNext('fixture'))!;
    assertEquals([third.id, third.attempts, third.lastError], [
      first.id,
      2,
      'rate limited',
    ]);
  });
});

Deno.test('startup resumes active jobs while kept completed work still dedupes after catalog rebuild', async () => {
  await setup(async (store, dir) => {
    await store.lookups.enqueue([input(), input({ entityId: 'done' })]);
    const active = (await store.lookups.claimNext('fixture'))!;
    const done = (await store.lookups.claimNext('fixture'))!;
    await store.lookups.finish(done.id, { state: 'done' });
    await store.catalog.replaceCatalog({
      artists: [],
      albums: [],
      albumIdentities: [],
      albumEvents: [],
      files: [],
      events: [],
      retainedIds: [],
    });
    await store.close();
    const reopened = await openStore(dir);
    try {
      const resumed = (await reopened.lookups.claimNext('fixture'))!;
      assertEquals([resumed.id, resumed.attempts], [active.id, 2]);
      assertEquals(
        await reopened.lookups.enqueue([input({ entityId: 'done' })]),
        [],
      );
    } finally {
      await reopened.close();
    }
  });
});

Deno.test('purgeDone only removes completed jobs older than the cutoff; stats are plugin-scoped', async () => {
  await setup(async (store) => {
    await store.lookups.enqueue([
      input(),
      input({ entityId: 'failed' }),
      input({ plugin: 'other' }),
    ]);
    await store.lookups.finish((await store.lookups.claimNext('fixture'))!.id, {
      state: 'done',
    });
    await store.lookups.finish((await store.lookups.claimNext('fixture'))!.id, {
      state: 'failed',
      error: 'kept',
    });
    await store.lookups.purgeDone(0);
    assertEquals(await store.lookups.stats('fixture'), {
      waiting: 0,
      active: 0,
      done: 1,
      failed: 1,
    });
    await store.lookups.purgeDone(Date.now() + 1000);
    assertEquals(await store.lookups.stats('fixture'), {
      waiting: 0,
      active: 0,
      done: 0,
      failed: 1,
    });
    assertEquals(await store.lookups.stats('other'), {
      waiting: 1,
      active: 0,
      done: 0,
      failed: 0,
    });
    assertEquals(await store.lookups.stats('missing'), {
      waiting: 0,
      active: 0,
      done: 0,
      failed: 0,
    });
  });
});

Deno.test('enqueue is atomic when one item violates the persistent queue contract', async () => {
  await setup(async (store) => {
    await assertRejects(() =>
      store.lookups.enqueue([
        input(),
        input({ entityId: 'bad', mode: 'invalid' as 'all' }),
      ])
    );
    assertEquals(await store.lookups.stats('fixture'), {
      waiting: 0,
      active: 0,
      done: 0,
      failed: 0,
    });
  });
});
