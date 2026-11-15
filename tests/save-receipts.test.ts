import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { createPersistence } from '../src/persistence.ts';
import { createOutputs } from '../src/player.ts';
import { openStore } from '../src/store/index.ts';
import { stopped } from './helpers/queue.ts';

Deno.test('existing publication admitted before close cannot fail after its runtime change', async () => {
  const dir = await Deno.makeTempDir({
    prefix: 'save-receipt-existing-close-',
  });
  const store = await openStore(dir);
  const persistence = createPersistence(store);
  let closing: Promise<void> | undefined;
  try {
    const result = await persistence.changePlayers(() => {
      persistence.saveVolume!(64);
      closing = persistence.close();
      return 'accepted';
    });
    assertEquals(result, 'accepted');
    await closing;
    assertEquals((await store.players.list())[0].volume, 64);
    assertEquals(persistence.health(), { pendingWrites: 0 });
  } finally {
    await closing;
    await persistence.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('existing publication retains its original queue bookmark across caller mutation', async () => {
  const dir = await Deno.makeTempDir({
    prefix: 'save-receipt-existing-snapshot-',
  });
  const store = await openStore(dir);
  let fail = true;
  const persistence = createPersistence(
    {
      ...store,
      players: {
        ...store.players,
        async saveChanges(changes) {
          if (fail) throw new Error('storage unavailable');
          await store.players.saveChanges(changes);
        },
      },
    },
    { event() {} },
    undefined,
    undefined,
    { set: () => ({ cancel() {} }) },
  );
  try {
    const snapshot = { ...stopped, positionMs: 123 };
    await persistence.changePlayers(() => {
      persistence.saveQueue({ items: [], nextId: 1, version: 1 }, snapshot);
    });
    snapshot.positionMs = 999;
    fail = false;
    await persistence.drain();
    assertEquals((await store.playback.loadPlayerState(1))!.positionMs, 123);
  } finally {
    fail = false;
    await persistence.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('published receipts acknowledge once while immutable whole batches save in order', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'save-receipts-' });
  const store = await openStore(dir);
  const attempts: Parameters<typeof store.players.saveChanges>[0][] = [];
  let fail = true;
  const persistence = createPersistence(
    {
      ...store,
      players: {
        ...store.players,
        async saveChanges(changes) {
          attempts.push(structuredClone(changes));
          if (fail) throw new Error('whole batch unavailable');
          await store.players.saveChanges(changes);
        },
      },
    },
    { event() {} },
    undefined,
    undefined,
    {
      set: () => ({ cancel() {} }),
    },
  );
  const engine = persistence.forPlayer(1);
  const outputs = createOutputs({ persistence });
  let applied = 0, saved = false;
  try {
    outputs.register({
      id: 'receipt',
      name: 'Receipt',
      type: 'Test',
      selected: false,
      volume: 40,
    });
    await outputs.adopt('receipt');
    const state = { ...stopped, repeat: 'single' as const };
    const queue = { items: [], nextId: 1, version: 1 };
    const first = persistence.publishedCommands.publish(() => {
      assertEquals(persistence.health(), { pendingWrites: 1 });
      applied++;
      outputs.setMembers(1, ['receipt']);
      engine.saveQueue(queue, state);
      engine.saveVolume!(60);
      engine.saveCommand!(123);
      return 'published';
    });
    void first.saved.then(() => saved = true);
    assertEquals(await first.command, 'published');
    assertEquals(applied, 1);
    assertEquals(saved, false);
    assertEquals(outputs.get('receipt')!.playerId, 1);
    assertEquals(persistence.health(), { pendingWrites: 1 });
    assertEquals(await store.playback.loadPlayerState(1), null);
    // Neither caller-owned state nor later publications can change batch one.
    state.positionMs = 999;
    queue.version = 999;
    const second = engine.publishedCommands.publish(() => {
      applied++;
      engine.saveVolume!(75);
      outputs.update('receipt', { volume: 75 });
    });
    await second.command;
    assertEquals(applied, 2);
    assertEquals(attempts.length, 2);
    assertEquals(attempts[1], attempts[0]);
    assertEquals(persistence.health(), { pendingWrites: 2 });
    fail = false;
    await persistence.drain();
    await Promise.all([first.saved, second.saved]);
    assertEquals(saved, true);
    assertEquals(applied, 2, 'retry saves the batch, never the callback');
    assertEquals(attempts.length, 4);
    assertEquals(attempts[2], attempts[0]);
    assertEquals(attempts[0].players![0].state!.positionMs, 0);
    assertEquals(attempts[0].players![0].queue!.version, 1);
    assertEquals(attempts[3].players![0].volume, 75);
    assertEquals((await store.playback.loadQueue(1)).version, 1);
    assertEquals((await store.playback.loadPlayerState(1))!.positionMs, 0);
    assertEquals((await store.players.list())[0].volume, 75);
    assertEquals((await store.speakers.loadMemberships())[0].playerId, 1);
    assertEquals((await store.speakers.loadAdopted())[0].volume, 75);
    assertEquals(persistence.health(), { pendingWrites: 0 });
  } finally {
    fail = false;
    await persistence.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('publication admission survives a reentrant close and refusals remain command failures', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'save-receipt-admission-' });
  const store = await openStore(dir);
  const persistence = createPersistence(store);
  const outputs = createOutputs({ persistence });
  let applied = 0;
  try {
    outputs.register({
      id: 'closing',
      name: 'Closing',
      type: 'Test',
      selected: false,
      volume: 40,
    });
    await outputs.adopt('closing');
    const refusal = new Error('refused before publication');
    assertThrows(
      () =>
        persistence.publishedCommands.publish(() => {
          throw refusal;
        }),
      Error,
      refusal.message,
    );
    assertEquals(persistence.health(), { pendingWrites: 0 });
    let close!: Promise<void>;
    const receipt = persistence.publishedCommands.publish(() => {
      applied++;
      close = persistence.close();
      persistence.saveVolume!(63);
      outputs.update('closing', { volume: 63 });
      assertEquals(persistence.health(), { pendingWrites: 1 });
      return 63;
    });
    assertEquals(await receipt.command, 63);
    await Promise.all([receipt.saved, close]);
    assertEquals(applied, 1);
    assertEquals((await store.players.list())[0].volume, 63);
    assertEquals((await store.speakers.loadAdopted())[0].volume, 63);
    assertEquals(persistence.health(), { pendingWrites: 0 });
    assertThrows(
      () => persistence.publishedCommands.publish(() => applied++),
      Error,
      'Persistence is closed',
    );
    await assertRejects(
      () => persistence.changeVolume!(() => applied++),
      Error,
      'Persistence is closed',
    );
    assertEquals(applied, 1);
  } finally {
    await persistence.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('durability-first adoption and ignore refuse without publishing cache or output changes', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'save-receipt-refusal-' });
  const store = await openStore(dir);
  const persistence = createPersistence({
    ...store,
    speakers: {
      ...store.speakers,
      saveAdopted: () => Promise.reject(new Error('adoption refused')),
      saveIgnored: () => Promise.reject(new Error('ignore refused')),
    },
  }, { event() {} });
  const outputs = createOutputs({ persistence });
  try {
    outputs.register({
      id: 'refused',
      name: 'Refused',
      type: 'Test',
      selected: false,
      volume: 40,
    });
    await assertRejects(
      () => outputs.adopt('refused'),
      Error,
      'adoption refused',
    );
    assert(!outputs.lifetime('refused').adopted);
    assertEquals(persistence.savedOutput('refused'), undefined);
    await assertRejects(
      () => persistence.setOutputIgnored!('refused', true),
      Error,
      'ignore refused',
    );
    assertEquals(persistence.ignoredOutputs!(), []);
    assertEquals(await store.speakers.loadAdopted(), []);
    assertEquals(await store.speakers.loadIgnored(), []);
    assertEquals(persistence.health(), { pendingWrites: 0 });
  } finally {
    await persistence.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
