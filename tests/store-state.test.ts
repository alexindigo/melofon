import { assertEquals, assertRejects } from '@std/assert';
import { createStateStore } from '../src/store/state.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('store.state.get returns null or the persisted value', async () => {
  const t = await domainFixture(createStateStore);
  try {
    assertEquals(await t.domain.get('missing'), null);
    await t.domain.set("key'", "value'");
    assertEquals(await t.domain.get("key'"), "value'");
  } finally {
    await t.close();
  }
});

Deno.test('store.state.set replaces an existing value', async () => {
  const t = await domainFixture(createStateStore);
  try {
    await t.domain.set('key', 'first');
    await t.domain.set('key', 'second');
    assertEquals(await t.domain.get('key'), 'second');
  } finally {
    await t.close();
  }
});

Deno.test('store.state.seedIfUnset is atomic for ordinary and strategy keys', async () => {
  const t = await domainFixture(createStateStore);
  try {
    t.failCommit();
    await assertRejects(
      () => t.domain.seedIfUnset('key', 'lost'),
      Error,
      'injected',
    );
    assertEquals(await t.domain.get('key'), null);
    for (const key of ['key', 'airplay.connectionStrategy.default']) {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => t.domain.seedIfUnset(key, `${i}`)),
      );
      assertEquals(results.filter(Boolean).length, 1);
      assertEquals(await t.domain.get(key), '0');
    }
  } finally {
    await t.close();
  }
});

Deno.test('store.state.list returns a plain key/value record', async () => {
  const t = await domainFixture(createStateStore);
  try {
    await t.domain.set('b', '2');
    await t.domain.set('a', '1');
    assertEquals(await t.domain.list(), { a: '1', b: '2' });
  } finally {
    await t.close();
  }
});
