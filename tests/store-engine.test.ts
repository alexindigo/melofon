import { assert, assertEquals, assertRejects } from '@std/assert';
import { atomic, openEngine, type Queries } from '../src/store/engine.ts';
import { openStore } from '../src/store/index.ts';
import { createStateStore } from '../src/store/state.ts';
import { rawSql } from '../src/store/testing.ts';
import { captureLogs } from './helpers/logging.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

Deno.test('store engine runs reads and writes exclusively in arrival order', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-engine-' });
  const engine = await openEngine(dir);
  const started = deferred(), release = deferred();
  try {
    const order: string[] = [];
    let running = 0;
    const first = engine.exclusive(async (q) => {
      order.push('first');
      started.resolve();
      await release.promise;
      await q.run("INSERT INTO state (key, value) VALUES ('key', 'value')");
    });
    await started.promise;
    const waiting = Array.from(
      { length: 10 },
      (_, i) =>
        engine.exclusive(async (q) => {
          assertEquals(running++, 0);
          order.push(`begin${i}`);
          assertEquals(await q.all('SELECT value FROM state'), [{
            value: 'value',
          }]);
          order.push(`end${i}`);
          running--;
        }),
    );
    assertEquals(order, ['first']);
    release.resolve();
    await Promise.all([first, ...waiting]);
    assertEquals(order, [
      'first',
      ...Array.from({ length: 10 }, (_, i) => [`begin${i}`, `end${i}`]).flat(),
    ]);
  } finally {
    release.resolve();
    await engine.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store engine releases a throwing slot and rolls back failed atomic work', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-engine-' });
  const engine = await openEngine(dir);
  try {
    await assertRejects(
      () =>
        engine.exclusive(() => {
          throw new Error('slot failed');
        }),
      Error,
      'slot failed',
    );
    await assertRejects(() =>
      atomic(engine, async (q) => {
        await q.run("INSERT INTO state (key, value) VALUES ('lost', 'value')");
        await q.run('INSERT INTO absent_table VALUES (1)');
      })
    );
    assertEquals(
      await engine.exclusive((q) => q.all('SELECT * FROM state')),
      [],
    );
    await engine.ping();
  } finally {
    await engine.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store engine rejects a nested public operation with a clear error', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-engine-' });
  const engine = await openEngine(dir);
  try {
    const state = createStateStore(engine);
    await assertRejects(
      () => engine.exclusive(() => state.get('key')),
      Error,
      'Nested store operation',
    );
    await state.set('key', 'after');
    assertEquals(await state.get('key'), 'after');
  } finally {
    await engine.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store engine runs schema on both first open and reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-engine-' });
  let engine = await openEngine(dir);
  try {
    assertEquals(
      (await engine.exclusive((q) => q.all('SELECT * FROM bookmarks'))).length,
      0,
    );
    await engine.exclusive(async (q) => {
      await q.run("INSERT INTO state (key, value) VALUES ('kept', 'value')");
      await q.run('DROP TABLE bookmarks');
    });
    await engine.close();
    engine = await openEngine(dir);
    assertEquals(
      await engine.exclusive((q) => q.all('SELECT track_id FROM bookmarks')),
      [],
    );
    assertEquals(
      await engine.exclusive((q) => q.all('SELECT key, value FROM state')),
      [{
        key: 'kept',
        value: 'value',
      }],
    );
  } finally {
    await engine.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store engine logging stays below the queue for concurrent domain and test-only operations', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-engine-' });
  const { log, records } = captureLogs();
  const store = await openStore(dir, { debugLogQueries: true, log });
  try {
    const offset = records().length;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => [
        store.state.set(`key${i}`, 'value'),
        store.state.get(`key${i}`),
        rawSql(store).run('SELECT 1'),
        rawSql(store).all('SELECT 1'),
      ]).flat(),
    );
    await assertRejects(() => rawSql(store).run('SELECT * FROM absent_table'));
    await store.ping();
    await log.flush();
    const spans = records().slice(offset);
    assert(spans.length > 0);
    assertEquals(
      spans.map((r) => r.event),
      Array.from({ length: spans.length / 2 }, () => ['db_begin', 'db_end'])
        .flat(),
    );
    assert(
      spans.filter((r) => r.event === 'db_begin').every((r) =>
        r.qinflight === '1'
      ),
    );
    assert(
      spans.filter((r) => r.event === 'db_end').every((r) =>
        r.waitMs !== undefined
      ),
    );
    assertEquals(spans.filter((r) => r.event === 'db_overlap'), []);
  } finally {
    await store.close();
    await log.flush();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store engine logging is opt-in and ping observes a live connection', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-engine-' });
  const { log, records } = captureLogs();
  const store = await openStore(dir, { log });
  try {
    await store.ping();
    assertEquals(records(), []);
    await store.close();
    await assertRejects(() => store.ping(), Error, 'closed');
  } finally {
    await store.close();
    await log.flush();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store engine close drains accepted work and rejects new operations', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-engine-' });
  const engine = await openEngine(dir);
  const started = deferred(), release = deferred();
  try {
    const write = engine.exclusive(async (q) => {
      started.resolve();
      await release.promise;
      await q.run("INSERT INTO state (key, value) VALUES ('drained', 'value')");
    });
    await started.promise;
    const closing = engine.close();
    await assertRejects(() => engine.ping(), Error, 'closed');
    release.resolve();
    await write;
    await closing;
    await engine.close();
    const reopened = await openStore(dir);
    try {
      assertEquals(await reopened.state.get('drained'), 'value');
    } finally {
      await reopened.close();
    }
  } finally {
    release.resolve();
    await engine.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store engine rejects escaped queries after their slot ends', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-engine-' });
  const engine = await openEngine(dir);
  try {
    let escaped!: Queries;
    await engine.exclusive((q) => {
      escaped = q;
      return Promise.resolve();
    });
    await assertRejects(
      () => escaped.run('SELECT 1'),
      Error,
      'outside its exclusive slot',
    );
    await engine.ping();
  } finally {
    await engine.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store engine converts plain rows and keeps prepared driver results inside its slot', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'store-engine-' });
  const engine = await openEngine(dir);
  try {
    assertEquals(
      await engine.exclusive((q) =>
        q.all('SELECT 12::BIGINT AS n, [1::BIGINT, 2::BIGINT] AS items')
      ),
      [{ n: 12, items: [1, 2] }],
    );
    await engine.exclusive(async (q) => {
      const bound = await q.prepare('SELECT $1::BIGINT AS n');
      try {
        bound.bind([13]);
        const result = await bound.runAndReadAll();
        assertEquals(result.getRowObjects()[0].n, 13n);
      } finally {
        bound.destroySync();
      }
      const stmt = await q.prepare('SELECT 14 AS n');
      try {
        assertEquals((await stmt.runAndReadAll()).getRowObjects(), [{ n: 14 }]);
      } finally {
        stmt.destroySync();
      }
    });
  } finally {
    await engine.close();
    await Deno.remove(dir, { recursive: true });
  }
});
