import { assertEquals, assertRejects } from '@std/assert';
import { createUsersStore } from '../src/store/users.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('store.users.count observes persisted users as a number', async () => {
  const t = await domainFixture(createUsersStore);
  try {
    assertEquals(await t.domain.count(), 2);
  } finally {
    await t.close();
  }
});

Deno.test('store.users.seedFirst is atomic and concurrent seeds insert once', async () => {
  const t = await domainFixture(createUsersStore);
  try {
    await t.run('DELETE FROM users');
    t.failCommit();
    await assertRejects(
      () => t.domain.seedFirst('lost', 'lost', 'lost'),
      Error,
      'injected',
    );
    assertEquals(await t.domain.count(), 0);
    await Promise.all(
      Array.from(
        { length: 20 },
        (_, i) => t.domain.seedFirst(`u${i}`, `name${i}`, 'secret'),
      ),
    );
    assertEquals(await t.domain.count(), 1);
    assertEquals(await t.domain.passwordForName('name0'), 'secret');
  } finally {
    await t.close();
  }
});

Deno.test('store.users.passwordForName returns only the encrypted password or null', async () => {
  const t = await domainFixture(createUsersStore);
  try {
    assertEquals(await t.domain.passwordForName('alice'), 'encrypted');
    assertEquals(await t.domain.passwordForName("alice' OR true --"), null);
  } finally {
    await t.close();
  }
});

Deno.test('store.users.passwordToken retains DuckDB md5 semantics and escaping', async () => {
  const t = await domainFixture(createUsersStore);
  try {
    assertEquals(
      await t.domain.passwordToken('abc'),
      '900150983cd24fb0d6963f7d28e17f72',
    );
  } finally {
    await t.close();
  }
});
