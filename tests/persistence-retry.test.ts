import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { createPersistence } from '../src/persistence.ts';
import { createOutputs } from '../src/player.ts';
import { openStore } from '../src/store/index.ts';
import { apiFixture } from './helpers/api.ts';
import { stopped } from './helpers/queue.ts';
import { until } from './helpers/speaker-consumer.ts';

Deno.test('closed persistence rejects captured publications before their runtime or cached state changes', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'persistence-admission-' });
  const store = await openStore(dir);
  const persistence = createPersistence(store);
  const outputs = createOutputs({ persistence });
  outputs.register({
    id: '11',
    name: 'Speaker',
    type: 'Test',
    selected: false,
    volume: 40,
  });
  try {
    await outputs.adopt('11');
    const before = outputs.get('11');
    const saved = persistence.savedOutput('11')!;
    await persistence.close();
    for (
      const change of [persistence.changeMemberships, persistence.changePlayers]
    ) {
      await assertRejects(
        () => change(() => outputs.setMembers(1, ['11'])),
        Error,
        'Persistence is closed',
      );
    }
    assertEquals(outputs.get('11'), before);
    assertEquals(persistence.savedOutput('11'), saved);
    assertEquals((await store.speakers.loadMemberships())[0].playerId, null);
    assertThrows(
      () => persistence.saveOutput({ ...saved, volume: 90 }),
      Error,
      'Persistence is closed',
    );
    assertThrows(
      () => persistence.saveState(stopped),
      Error,
      'Persistence is closed',
    );
    assertEquals(persistence.savedOutput('11'), saved);
    assertEquals(persistence.health(), { pendingWrites: 0 });
  } finally {
    await persistence.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('closed persistence rejects forget without removing its adopted cache or stored speaker', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'persistence-forget-close-' });
  const store = await openStore(dir);
  const persistence = createPersistence(store);
  const row = {
    id: '11',
    name: 'Speaker',
    type: 'Test',
    selected: false,
    volume: 40,
  };
  try {
    await persistence.adoptOutput!(row);
    const saved = persistence.savedOutput('11');
    await persistence.close();
    await assertRejects(
      () => persistence.deleteOutput!('11'),
      Error,
      'Persistence is closed',
    );
    assertEquals(persistence.savedOutput('11'), saved);
    assertEquals((await store.speakers.loadAdopted()).map((row) => row.id), [
      '11',
    ]);
    assertEquals(persistence.health(), { pendingWrites: 0 });
  } finally {
    await persistence.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('health counts a published save waiting behind an accepted configuration write until close drains both', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let persistence!: ReturnType<typeof createPersistence>;
  const f = await apiFixture({
    services: ({ store }) => {
      persistence = createPersistence({
        ...store,
        speakers: {
          ...store.speakers,
          async saveAdopted(row, records) {
            entered.resolve();
            await release.promise;
            await store.speakers.saveAdopted(row, records);
          },
        },
      });
      return Promise.resolve({ persistence });
    },
  });
  const adopting = persistence.adoptOutput!({
    id: '11',
    name: 'Speaker',
    type: 'Test',
    selected: false,
    volume: 40,
  });
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    persistence.saveState({ ...stopped, repeat: 'all' });
    closing = persistence.close();
    const health = await f.request('/_/health');
    assertEquals(health.status, 503);
    assertEquals(await health.json(), {
      ok: false,
      persistence: { pendingWrites: 1 },
    });
    assertEquals(await f.store.playback.loadPlayerState(1), null);
    release.resolve();
    await Promise.all([adopting, closing]);
    assertEquals((await f.store.playback.loadPlayerState(1))?.repeat, 'all');
    const healthy = await f.request('/_/health');
    assertEquals(healthy.status, 200);
    assertEquals(await healthy.json(), { ok: true });
  } finally {
    release.resolve();
    await adopting;
    await closing;
    await persistence.close();
    await f.close();
  }
});

Deno.test('a failed close retains ordered published batches and a shared retry close can save them without reopening admission', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'persistence-close-retry-' });
  const store = await openStore(dir);
  let fail = true;
  const writes: string[] = [];
  const persistence = createPersistence({
    ...store,
    playback: {
      ...store.playback,
      async saveState(id, state) {
        if (fail) throw new Error('storage offline');
        writes.push(state.repeat);
        await store.playback.saveState(id, state);
      },
    },
  }, { event() {} });
  try {
    persistence.saveState({ ...stopped, repeat: 'single' });
    persistence.saveState({ ...stopped, repeat: 'all' });
    const first = persistence.close();
    assertEquals(persistence.close(), first);
    await assertRejects(() => first, Error, 'storage offline');
    assertEquals(persistence.health(), { pendingWrites: 2 });
    assertEquals(await store.playback.loadPlayerState(1), null);
    fail = false;
    const retry = persistence.close();
    assertEquals(persistence.close(), retry);
    await retry;
    assertEquals(writes, ['single', 'all']);
    assertEquals((await store.playback.loadPlayerState(1))?.repeat, 'all');
    assertEquals(persistence.health(), { pendingWrites: 0 });
    await assertRejects(
      () => persistence.changePlayers(() => 'late'),
      Error,
      'Persistence is closed',
    );
  } finally {
    fail = false;
    await persistence.drain();
    await persistence.close().catch(() => {});
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

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
