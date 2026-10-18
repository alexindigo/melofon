import { assert, assertEquals } from '@std/assert';
import { openStore } from '../src/store/index.ts';
import { createPersistence } from '../src/persistence.ts';
import { LookupHost } from '../src/lookups/host.ts';
import { discoverLookups } from '../src/lookups/manifest.ts';
import { createLookupNetwork } from '../src/lookups/net.ts';
import { lookupPlugin } from './helpers/lookup.ts';

Deno.test('3000 plugin jobs claim and complete while playback saves every 50ms without failed writes', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(`${dir}/data`);
  let failures = 0, saves = 0;
  const persistence = createPersistence(store, {
    event(event) {
      if (event === 'persistence_failed') failures++;
    },
  });
  await lookupPlugin(`${dir}/lookups`);
  const host = new LookupHost(
    (await discoverLookups(`${dir}/lookups`, `${dir}/data`))[0],
    createLookupNetwork(),
  );
  const timer = setInterval(() => {
    saves++;
    persistence.saveState({
      state: 'pause',
      currentIndex: 0,
      positionMs: saves,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
  }, 50);
  try {
    await store.lookups.enqueue(
      Array.from(
        { length: 3000 },
        (_, i) => ({
          plugin: 'fixture',
          entityType: 'album' as const,
          entityId: String(i),
          factsHash: 'facts',
          mode: 'missing' as const,
        }),
      ),
    );
    await host.start();
    const claimed = new Set<string>();
    for (;;) {
      const job = await store.lookups.claimNext('fixture');
      if (!job) break;
      assert(!claimed.has(job.id));
      claimed.add(job.id);
      assertEquals(
        await host.call(host.plugin.manifest!.capabilities[0], {
          id: job.entityId,
        }, { timeoutMs: 1000, maxBytes: 1024 }),
        { candidates: [] },
      );
      await store.lookups.finish(job.id, { state: 'done' });
    }
    clearInterval(timer);
    await persistence.drain();
    assertEquals(claimed.size, 3000);
    assertEquals(await store.lookups.stats('fixture'), {
      waiting: 0,
      active: 0,
      done: 3000,
      failed: 0,
    });
    assertEquals(failures, 0);
    assert(saves > 0);
    assertEquals((await persistence.loadPlayerState())?.positionMs, saves);
  } finally {
    clearInterval(timer);
    await host.stop();
    await persistence.drain();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
