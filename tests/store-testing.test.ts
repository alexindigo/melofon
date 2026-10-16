import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { openStore, type Store } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-store-testing-' });
  const store = await openStore(dir);
  return {
    store,
    sql: rawSql(store),
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('rawSql preserves driver rows while semantic operations return plain data', async () => {
  const t = await fixture();
  try {
    await t.sql.run("INSERT INTO state VALUES ('seeded', 'value')");
    assertEquals(await t.store.state.get('seeded'), 'value');
    assertEquals(await t.sql.all('SELECT count(*) AS n FROM state'), [{
      n: 1n,
    }]);
    assertEquals(await t.store.users.count(), 0);
    const rows = await t.sql.all('SELECT [1::BIGINT, 2::BIGINT] AS items');
    const list = rows[0].items as { items: bigint[]; toString(): string };
    assertEquals(list.constructor.name, 'DuckDBListValue');
    assertEquals(list.items, [1n, 2n]);
    assertEquals(list.toString(), '[1, 2]');
  } finally {
    await t.close();
  }
});

Deno.test('rawSql rejects control statements after whitespace and nested comments on both paths', async () => {
  const t = await fixture();
  try {
    for (
      const prefix of [
        '',
        ' \t\n',
        '-- leading\r\n',
        '/* outer /* inner */ still outer */ -- x\n',
      ]
    ) {
      for (
        const statement of [
          'BEGIN TRANSACTION',
          'cOmMiT',
          'ROLLBACK',
          'CHECKPOINT',
          "ATTACH ':memory:' AS other",
          'START TRANSACTION',
          'END',
          'ABORT',
          'FORCE CHECKPOINT',
          'DETACH other',
          'CALL checkpoint()',
          'PREPARE escaped AS SELECT 1',
          'EXECUTE escaped',
        ]
      ) {
        for (const query of [t.sql.run, t.sql.all]) {
          await assertRejects(
            () => query(prefix + statement),
            Error,
            'rawSql rejects',
          );
        }
      }
    }
    await t.store.state.set('after', 'kept');
    assertEquals(await t.store.state.get('after'), 'kept');
  } finally {
    await t.close();
  }
});

Deno.test('rawSql rejects statement batches before any prefix can execute', async () => {
  const t = await fixture();
  try {
    for (const query of [t.sql.run, t.sql.all]) {
      for (
        const suffix of [
          'BEGIN',
          '/* outer /* inner */ */ COMMIT',
          "INSERT INTO state VALUES ('other', 'lost')",
        ]
      ) {
        await assertRejects(
          () => query(`INSERT INTO state VALUES ('prefix', 'lost'); ${suffix}`),
          Error,
          'only one statement',
        );
      }
    }
    assertEquals(await t.store.state.list(), {});
  } finally {
    await t.close();
  }
});

Deno.test('rawSql handles quoted delimiters, rejects malformed input and follows store close', async () => {
  const t = await fixture();
  try {
    assertEquals(
      await t.sql.all("SELECT '; BEGIN -- /*' AS value; /* trailing */"),
      [{ value: '; BEGIN -- /*' }],
    );
    assertEquals(await t.sql.all('SELECT $$; BEGIN$$ AS value'), [{
      value: '; BEGIN',
    }]);
    assertEquals(await t.sql.all("SELECT 'it''s; COMMIT' AS value"), [{
      value: "it's; COMMIT",
    }]);
    assertEquals(
      await t.sql.all(String.raw`SELECT E'it\'s; ROLLBACK' AS value`),
      [{ value: "it's; ROLLBACK" }],
    );
    for (
      const sql of [
        "SELECT 'unfinished",
        'SELECT $$unfinished',
        '/* unfinished',
      ]
    ) {
      await assertRejects(() => t.sql.run(sql), Error, 'Unterminated');
    }
    assertThrows(() => rawSql({} as Store), Error, 'Unknown store');
    await t.store.close();
    await assertRejects(() => t.sql.all('SELECT 1'), Error, 'closed');
  } finally {
    await t.close();
  }
});
