import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { authFixture } from './helpers/authentication.ts';
import { encryptPassword, UserError } from '../src/users.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';
import { createAuthentication } from '../src/authentication.ts';
import { createState } from '../src/state.ts';
import { createPasswordVerifier } from '../src/password-verifier.ts';
import { loadLayers } from '../src/layers.ts';
import { facade } from '../src/facade.ts';
import { pathfinder } from '@pathfinder/pathfinder';
import { captureLogs } from './helpers/logging.ts';
import type { Log } from '../src/logging.ts';

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

Deno.test('users core: create, case uniqueness, rename and id-owned data survive', async () => {
  const f = await authFixture();
  try {
    const user = await f.auth.users.create(f.admin.id, {
      username: 'Alice',
      password: 'password-alice',
      role: 'user',
      email: 'unverified@example.test',
    });
    assertEquals([
      user.displayName,
      user.email,
      user.lastLoginAt,
      user.lastAccessAt,
    ], ['Alice', 'unverified@example.test', null, null]);
    await assertRejects(
      () =>
        f.auth.users.create(f.admin.id, {
          username: 'aLiCe',
          password: 'password-other',
          role: 'user',
        }),
      UserError,
      'name_taken',
    );
    await assertRejects(
      () =>
        f.auth.users.create(f.admin.id, {
          username: 'short',
          password: '1234567',
          role: 'user',
        }),
      UserError,
      'password_too_short',
    );
    const signed = await f.signIn('ALICE', 'password-alice');
    const renamed = await f.auth.users.update(f.admin.id, user.id, {
      username: 'Renamed',
    });
    assertEquals([renamed.id, renamed.displayName], [user.id, 'Renamed']);
    assertEquals(
      (await f.auth.sessions.authenticate(signed.key))?.user.username,
      'Renamed',
    );
    await assertRejects(() => f.signIn('Alice', 'password-alice'));
    assert(
      (await f.signIn('renamed', 'password-alice')).key.startsWith('mfs_'),
    );
    await assertRejects(
      () => f.auth.users.update(f.admin.id, user.id, { username: 'ADMIN' }),
      UserError,
      'name_taken',
    );
    assertEquals(
      (await f.auth.users.get(f.admin.id, user.id)).username,
      'Renamed',
    );
  } finally {
    await f.close();
  }
});

Deno.test('users core: admin-or-self, fresh permissions and last-admin guard', async () => {
  const f = await authFixture();
  try {
    const user = await f.auth.users.create(f.admin.id, {
      username: 'other',
      password: 'password-other',
      role: 'user',
    });
    await f.auth.users.update(user.id, user.id, {
      displayName: 'Other Name',
      email: 'mail@example.test',
    });
    assertEquals(
      (await f.auth.users.get(user.id, user.id)).displayName,
      'Other Name',
    );
    for (
      const action of [
        () => f.auth.users.get(user.id, f.admin.id),
        () => f.auth.users.list(user.id),
        () =>
          f.auth.users.create(user.id, {
            username: 'denied',
            password: 'password-denied',
            role: 'user' as const,
          }),
        () => f.auth.users.update(user.id, user.id, { username: 'denied' }),
        () => f.auth.users.update(user.id, user.id, { role: 'admin' as const }),
        () => f.auth.users.setRole(user.id, user.id, 'admin'),
      ]
    ) await assertRejects(action, UserError, 'forbidden');
    await assertRejects(
      () => f.auth.users.setRole(f.admin.id, f.admin.id, 'user'),
      UserError,
      'last_admin',
    );
    await assertRejects(
      () => f.auth.users.get(f.admin.id, 'absent'),
      UserError,
      'not_found',
    );
    await f.auth.users.setRole(f.admin.id, user.id, 'admin');
    const signed = await f.signIn('other', 'password-other');
    assertEquals(
      (await f.auth.sessions.authenticate(signed.key))?.user.role,
      'admin',
    );
    await f.auth.users.setRole(f.admin.id, user.id, 'user');
    assertEquals(
      (await f.auth.sessions.authenticate(signed.key))?.user.role,
      'user',
    );
    await assertRejects(
      () => f.auth.users.list(user.id),
      UserError,
      'forbidden',
    );
    const results = await Promise.allSettled([
      f.auth.users.setRole(f.admin.id, f.admin.id, 'user'),
      f.auth.users.setRole(f.admin.id, f.admin.id, 'user'),
    ]);
    assertEquals(results.map((r) => r.status), ['rejected', 'rejected']);
    await f.auth.users.setRole(f.admin.id, user.id, 'admin');
    const demotions = await Promise.allSettled([
      f.auth.users.setRole(f.admin.id, f.admin.id, 'user'),
      f.auth.users.setRole(user.id, user.id, 'user'),
    ]);
    assertEquals(demotions.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = demotions.find((r) => r.status === 'rejected');
    assert(rejected?.status === 'rejected');
    assertEquals(rejected.reason.code, 'last_admin');
  } finally {
    await f.close();
  }
});

Deno.test('users core: BASE schema upgrades once, preserves passwords and case-colliding users', async () => {
  const f = await authFixture();
  let store = f.store;
  const captured = captureLogs();
  try {
    const raw = rawSql(store);
    await raw.run('DROP TABLE users');
    await raw.run(
      "CREATE TABLE users (id VARCHAR PRIMARY KEY, name VARCHAR UNIQUE NOT NULL, password_enc VARCHAR NOT NULL, created_at TIMESTAMPTZ NOT NULL, role VARCHAR NOT NULL DEFAULT 'user')",
    );
    await raw.run("DELETE FROM migrations WHERE id = 'users-001'");
    const enc = quote(await encryptPassword(f.cfg.secret, 'legacy'));
    await raw.run(
      `INSERT INTO users VALUES ('a', 'Legacy', ${enc}, epoch_ms(1000), 'admin'), ('b', 'legacy', ${enc}, epoch_ms(2000), 'user')`,
    );
    await store.close();
    store = await openStore(f.dir, { log: captured.log });
    const auth = createAuthentication(store, f.cfg, createState(store));
    for (const [username, id] of [['Legacy', 'a'], ['legacy', 'b']]) {
      const signed = await auth.signIn({
        username,
        password: 'legacy',
        clientAddress: 'test',
        deviceName: 'old',
        userAgent: 'test',
      });
      const user = (await auth.sessions.authenticate(signed.key))!.user;
      assertEquals([user.id, user.displayName, user.email], [
        id,
        username,
        null,
      ]);
      assert(user.lastLoginAt !== null);
    }
    await captured.log.flush();
    assertEquals(
      captured.records().filter((r) => r.event === 'user_name_collision')
        .length,
      1,
    );
    await assertRejects(
      () =>
        auth.users.create('a', {
          username: 'LEGACY',
          password: 'new-password',
          role: 'user',
        }),
      UserError,
      'name_taken',
    );
    await auth.users.update('a', 'b', { username: 'Resolved' });
    await store.close();
    store = await openStore(f.dir, { log: captured.log });
    assertEquals((await store.users.byId('b'))?.username, 'Resolved');
    assertEquals(
      (await rawSql(store).all(
        "SELECT id FROM migrations WHERE id = 'users-001'",
      )).length,
      1,
    );
    await captured.log.flush();
    assertEquals(
      captured.records().filter((r) => r.event === 'user_name_collision')
        .length,
      1,
    );
  } finally {
    await store.close();
    await captured.log.flush();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('password verifier: plaintext and md5 stay outside SQL; unknown and wrong use identical query work', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-verifier-' });
  const sql: string[] = [];
  const log: Log = {
    event(_event, facts) {
      if ('sql' in facts) sql.push(facts.sql);
    },
  };
  const store = await openStore(dir, { debugLogQueries: true, log });
  try {
    const password = "private-'password-123";
    await store.users.seedFirst(
      'admin-id',
      'admin',
      await encryptPassword('secret', password),
    );
    const verifier = createPasswordVerifier(store, { secret: 'secret' });
    sql.length = 0;
    assert((await verifier({ username: 'admin' }, { password })) !== null);
    assert(
      (await verifier({ username: 'admin' }, {
        token: createHash('md5').update(password + 'salt').digest('hex')
          .toUpperCase(),
        salt: 'salt',
      })) !== null,
    );
    assert(!sql.some((s) => s.includes(password) || /md5\s*\(/i.test(s)));
    sql.length = 0;
    assertEquals(
      await verifier({ username: 'admin' }, { password: 'wrong' }),
      null,
    );
    const wrong = [...sql];
    sql.length = 0;
    assertEquals(
      await verifier({ username: 'unknown' }, { password: 'wrong' }),
      null,
    );
    assertEquals(sql, wrong);
    assertEquals(
      await verifier({ username: 'unknown' }, { token: 'bad', salt: 'salt' }),
      null,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('users core: legacy hat auth notes access, throttles it, and returns display-name fallback', async () => {
  const f = await authFixture();
  try {
    assertEquals(await f.auth.user.auth('admin', 'password-admin'), {
      username: 'admin',
      displayName: 'admin',
    });
    const first = (await f.auth.users.get(f.admin.id, f.admin.id)).lastAccessAt;
    assert(first !== null);
    f.advance(59000);
    await f.auth.user.authMd5(
      'admin',
      createHash('md5').update('password-adminsalt').digest('hex'),
      'salt',
    );
    assertEquals(
      (await f.auth.users.get(f.admin.id, f.admin.id)).lastAccessAt,
      first,
    );
    f.advance(1000);
    await f.auth.users.update(f.admin.id, f.admin.id, {
      displayName: 'Administrator',
    });
    assertEquals(
      (await f.auth.user.auth('admin', 'password-admin'))?.displayName,
      'Administrator',
    );
    assertEquals(
      (await f.auth.users.get(f.admin.id, f.admin.id)).lastAccessAt,
      new Date(f.now()).toISOString(),
    );
  } finally {
    await f.close();
  }
});

Deno.test('hat injection: every mount receives config without secrets and usable native services', async () => {
  const f = await authFixture();
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  try {
    const root = `${f.dir}/layers`;
    await Deno.mkdir(`${root}/probe/routes/read`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/probe/manifest.json`,
      JSON.stringify({ routes: '/probe' }),
    );
    await Deno.writeTextFile(
      `${root}/probe/routes/read/get.ts`,
      `export default (_request, context) => ({cfg: context.app.cfg, keys: Object.keys(context.app), sessions: Object.keys(context.app.sessions)});`,
    );
    const core = await pathfinder({
      roots: ['core/'],
      app: { store: f.store },
    });
    const layers = await loadLayers({
      layersRoot: root,
      app: { ...f.auth, cfg: f.cfg, state: f.state, store: f.store },
    });
    server = Deno.serve(
      { hostname: '0.0.0.0', port: 0, onListen() {} },
      facade(core, layers),
    );
    const response = await fetch(
      `http://melofon.home:${server.addr.port}/probe/read`,
      { signal: AbortSignal.timeout(2000) },
    );
    const body = await response.json();
    assertEquals(response.status, 200);
    assertEquals(body.cfg, { dataDir: f.dir, user: 'admin', version: 'a3' });
    assert(!body.keys.includes('store'));
    for (const key of ['users', 'sessions', 'signIn', 'user']) {
      assert(body.keys.includes(key));
    }
    for (const key of ['create', 'ended']) assert(!body.sessions.includes(key));
    assertEquals(f.cfg.secret, 'test-secret');
  } finally {
    await server?.shutdown();
    await f.close();
  }
});
