import { assertEquals } from '@std/assert';
import { h9Facade, h9Setup, quote } from './helpers/h9.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { encryptPassword, seedFirstUser } from '../src/users.ts';

Deno.test('H9 first-user admin and getUser/getUsers rights over GET, POST and XML', async () => {
  const s = await h9Setup();
  try {
    for (const name of ['admin', 'alice', 'bob']) {
      for (const post of [false, true]) {
        const user =
          (await s.ok('getUser', { username: name }, name, post)).user;
        assertEquals([user.username, user.adminRole], [name, name === 'admin']);
      }
      const user = (await s.ok('getUser', { username: name })).user;
      assertEquals([user.username, user.adminRole], [name, name === 'admin']);
    }
    await s.error(10, 'getUser');
    await s.error(70, 'getUser', { username: 'unknown' });
    for (const user of ['alice', 'bob']) {
      for (const username of ['admin', 'unknown']) {
        await s.error(50, 'getUser', { username }, user);
      }
      await s.error(50, 'getUsers', {}, user);
    }
    const users = (await s.ok('getUsers', {}, 'admin', true)).users.user;
    assertEquals(users.map((u) => [u.username, u.adminRole]), [
      ['admin', true],
      ['alice', false],
      ['bob', false],
    ]);
    const xml = await s.request('getUser', { username: 'bob', f: 'xml' });
    assertEquals(
      /<user[^>]*username="bob"[^>]*adminRole="false"/.test(await xml.text()),
      true,
    );
  } finally {
    await s.close();
  }
});

Deno.test('H9 BASE-shaped upgrade promotes only the seeded user, defaults private, and preserves recorded roles on reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-h9-upgrade-' });
  let store = await openStore(dir);
  try {
    const fixture = await Deno.readTextFile('tests/fixtures/schema-pre-h9.sql');
    for (const table of ['playlist_tracks', 'playlists', 'users']) {
      await rawSql(store).run(`DROP TABLE ${table}`);
    }
    for (const statement of fixture.split(';')) {
      if (statement.trim()) await rawSql(store).run(statement);
    }
    const enc = quote(await encryptPassword('h9-secret', 'test'));
    await rawSql(store).run(
      `INSERT INTO users VALUES ('seed', 'seeded', ${enc}, epoch_ms(1000)), ('other', 'other', ${enc}, epoch_ms(2000))`,
    );
    await rawSql(store).run(
      "INSERT INTO playlists VALUES ('kept', 'seed', 'Kept', 'comment', epoch_ms(3000), epoch_ms(4000))",
    );
    await rawSql(store).run(
      "INSERT INTO playlist_tracks VALUES ('kept', 0, 'returning')",
    );
    assertEquals(
      await rawSql(store).all(
        "SELECT column_name FROM information_schema.columns WHERE (table_name='users' AND column_name='role') OR (table_name='playlists' AND column_name='public')",
      ),
      [],
    );
    await store.close();
    store = await openStore(dir);
    let api = await h9Facade(store, dir);
    assertEquals(
      (await api.ok('getUsers', {}, 'seeded')).users.user.map((
        u,
      ) => [u.username, u.adminRole]),
      [['other', false], ['seeded', true]],
    );
    await api.error(50, 'getUsers', {}, 'other');
    const kept =
      (await api.ok('getPlaylist', { id: 'kept' }, 'seeded')).playlist;
    assertEquals([kept.public, kept.owner, kept.songCount], [
      false,
      'seeded',
      0,
    ]);
    assertEquals(
      await rawSql(store).all(
        'SELECT epoch_ms(created_at) AS created, epoch_ms(changed_at) AS changed FROM playlists',
      ),
      [{ created: 3000n, changed: 4000n }],
    );
    await api.error(70, 'getPlaylist', { id: 'kept' }, 'other');
    assertEquals(
      await rawSql(store).all('SELECT track_id FROM playlist_tracks'),
      [{ track_id: 'returning' }],
    );
    await rawSql(store).run(
      "UPDATE users SET role = 'user' WHERE name = 'seeded'",
    );
    await rawSql(store).run(
      "UPDATE users SET role = 'admin' WHERE name = 'other'",
    );
    await api.ok(
      'updatePlaylist',
      { playlistId: 'kept', public: 'true' },
      'seeded',
    );
    const changed = await rawSql(store).all(
      'SELECT epoch_ms(created_at) AS created, epoch_ms(changed_at) AS changed FROM playlists',
    );
    await store.close();
    store = await openStore(dir);
    api = await h9Facade(store, dir);
    await seedFirstUser(store, api.cfg);
    assertEquals(
      (await api.ok('getUsers', {}, 'other')).users.user.map((
        u,
      ) => [u.username, u.adminRole]),
      [['other', true], ['seeded', false]],
    );
    assertEquals(
      (await api.ok('getPlaylist', { id: 'kept' }, 'other')).playlist.public,
      true,
    );
    assertEquals(
      await rawSql(store).all(
        'SELECT epoch_ms(created_at) AS created, epoch_ms(changed_at) AS changed FROM playlists',
      ),
      changed,
    );
    await rawSql(store).run(
      `INSERT INTO users (id, name, password_enc, created_at) VALUES ('later', 'later', ${enc}, now())`,
    );
    assertEquals(
      (await api.ok('getUser', { username: 'later' }, 'other')).user.adminRole,
      false,
    );
    await api.error(50, 'getUsers', {}, 'later');
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
