import { assert, assertEquals, assertRejects } from '@std/assert';
import { createPersistence } from '../src/persistence.ts';
import { openStore } from '../src/store/index.ts';
import { stopped } from './helpers/queue.ts';
import { until } from './helpers/speaker-consumer.ts';

Deno.test('household retry owner caps backoff, serializes attempts and closes before the store', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'persistence-retry-' });
  const store = await openStore(dir);
  let fail = true, calls = 0, active = 0, maximum = 0;
  const wakeups: { fire(): void; delay: number; cancelled: boolean }[] = [];
  const persistence = createPersistence(
    {
      ...store,
      playback: {
        ...store.playback,
        async saveState(id, state) {
          calls++;
          maximum = Math.max(maximum, ++active);
          try {
            if (fail) throw new Error('storage offline');
            await store.playback.saveState(id, state);
          } finally {
            active--;
          }
        },
      },
    },
    { event() {} },
    undefined,
    {
      declare(key) {
        assertEquals(key, 'persistence.retryBackoffMs');
      },
      getTyped: () => Promise.resolve([3, 7]),
      onChange: () => () => {},
    },
    {
      set(fire, delay) {
        const wakeup = { fire, delay, cancelled: false };
        wakeups.push(wakeup);
        return { cancel: () => wakeup.cancelled = true };
      },
    },
  );
  try {
    persistence.saveState({ ...stopped, repeat: 'all' });
    await until(() => wakeups.length === 1);
    for (let i = 0; i < 3; i++) {
      wakeups[i].fire();
      await until(() => wakeups.length === i + 2);
    }
    assertEquals(wakeups.map((wakeup) => wakeup.delay), [3, 7, 7, 7]);
    assertEquals(maximum, 1);
    fail = false;
    // Close itself drains the pending snapshot while storage is still open.
    await persistence.close();
    assertEquals((await store.playback.loadPlayerState(1))?.repeat, 'all');
    assertEquals(persistence.health(), { pendingWrites: 0 });
    assert(wakeups[3].cancelled);
    await store.close();
    const before = calls;
    for (const wakeup of wakeups) wakeup.fire();
    await Promise.resolve();
    assertEquals(
      calls,
      before,
      'closed owner ignores even already-queued callbacks',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('retiring an engine leaves household retries alive; failed household close cancels its wakeup', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'persistence-retire-' });
  const store = await openStore(dir);
  const other = await store.players.create('Kitchen');
  let fail = true, calls = 0;
  const wakeups: { fire(): void; cancelled: boolean }[] = [];
  const persistence = createPersistence(
    {
      ...store,
      playback: {
        ...store.playback,
        async saveState(id, state) {
          calls++;
          if (fail) throw new Error('storage offline');
          await store.playback.saveState(id, state);
        },
      },
    },
    { event() {} },
    undefined,
    undefined,
    {
      set(fire) {
        const wakeup = { fire, cancelled: false };
        wakeups.push(wakeup);
        return { cancel: () => wakeup.cancelled = true };
      },
    },
  );
  try {
    const retired = persistence.forPlayer(other.id);
    retired.saveState(stopped);
    await until(() => wakeups.length === 1);
    retired.retire();
    persistence.saveState({ ...stopped, repeat: 'single' });
    await until(() => wakeups.length === 2);
    fail = false;
    wakeups[1].fire();
    await until(() => persistence.health().pendingWrites === 0);
    assertEquals((await store.playback.loadPlayerState(1))?.repeat, 'single');
    fail = true;
    persistence.saveState({ ...stopped, repeat: 'all' });
    await until(() => wakeups.length === 3);
    await assertRejects(() => persistence.close(), Error, 'storage offline');
    assert(wakeups[2].cancelled);
    const before = calls;
    for (const wakeup of wakeups) wakeup.fire();
    await Promise.resolve();
    assertEquals(calls, before);
    assertEquals(persistence.health(), { pendingWrites: 1 });
    assertEquals((await store.playback.loadPlayerState(1))?.repeat, 'single');
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
