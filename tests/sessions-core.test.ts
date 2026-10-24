import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { authFixture } from './helpers/authentication.ts';
import { rawSql } from '../src/store/testing.ts';
import { UserError } from '../src/users.ts';
import type { SessionsEnded } from '../src/sessions.ts';
import { createSessions } from '../src/sessions.ts';
import { openStore } from '../src/store/index.ts';
import { createAuthentication } from '../src/authentication.ts';
import { createState } from '../src/state.ts';

Deno.test('sessions core: opaque public id, only SHA256 key hashes persisted; fresh role and rename', async () => {
  const f = await authFixture();
  try {
    const signed = await f.signIn();
    assert(/^mfs_[A-Za-z0-9_-]{43}$/.test(signed.key));
    assert(signed.session.id !== signed.key);
    const rows = await rawSql(f.store).all<{ key_hash: string }>(
      'SELECT * FROM sessions',
    );
    assertEquals(
      rows[0].key_hash,
      createHash('sha256').update(signed.key).digest('hex'),
    );
    assert(
      !JSON.stringify(
        rows,
        (_key, value) => typeof value === 'bigint' ? value.toString() : value,
      ).includes(
        signed.key,
      ),
    );
    assertEquals(signed.session.createdAt, new Date(f.now()).toISOString());
    assertEquals(
      (await f.auth.sessions.authenticate(signed.key))?.user.id,
      f.admin.id,
    );
    assertEquals(await f.auth.sessions.authenticate(signed.key + 'x'), null);
    assertEquals(
      (await f.auth.sessions.list(f.admin.id))[0].id,
      signed.session.id,
    );
  } finally {
    await f.close();
  }
});

Deno.test('sessions core: revoke one/all, ownership, admin and ended notification consumers', async () => {
  const f = await authFixture();
  try {
    const user = await f.auth.users.create(f.admin.id, {
      username: 'other',
      password: 'password-other',
      role: 'user',
    });
    const a = await f.signIn(),
      b = await f.signIn(),
      c = await f.signIn('other', 'password-other');
    const ended: SessionsEnded[] = [];
    const unsubscribe = f.auth.sessions.onSessionsEnded((event) =>
      ended.push(event)
    );
    await assertRejects(
      () => f.auth.sessions.revoke(user.id, a.session.id),
      UserError,
      'forbidden',
    );
    await assertRejects(
      () => f.auth.sessions.list(user.id, f.admin.id),
      UserError,
      'forbidden',
    );
    await assertRejects(
      () => f.auth.sessions.revokeAll(user.id, f.admin.id),
      UserError,
      'forbidden',
    );
    await f.auth.sessions.revoke(f.admin.id, a.session.id);
    assertEquals(await f.auth.sessions.authenticate(a.key), null);
    assert((await f.auth.sessions.authenticate(b.key)) !== null);
    assertEquals(ended, [{ userId: f.admin.id, sessionIds: [a.session.id] }]);
    await f.auth.sessions.revokeAll(f.admin.id);
    assertEquals(await f.auth.sessions.authenticate(b.key), null);
    assert((await f.auth.sessions.authenticate(c.key)) !== null);
    await f.auth.sessions.revoke(f.admin.id, c.session.id);
    assertEquals(await f.auth.sessions.authenticate(c.key), null);
    assertEquals(ended.length, 3);
    unsubscribe();
    const d = await f.signIn();
    await f.auth.sessions.revoke(f.admin.id, d.session.id);
    assertEquals(ended.length, 3);
  } finally {
    await f.close();
  }
});

Deno.test('sessions core: self password change requires current proof and ends caller plus every other device', async () => {
  const f = await authFixture();
  try {
    const a = await f.signIn(), b = await f.signIn();
    const ended: SessionsEnded[] = [];
    f.auth.sessions.onSessionsEnded((event) => ended.push(event));
    await assertRejects(
      () =>
        f.auth.users.setPassword(f.admin.id, f.admin.id, {
          new: 'new-password',
        }),
      UserError,
      'Wrong username or password',
    );
    await assertRejects(
      () =>
        f.auth.users.setPassword(f.admin.id, f.admin.id, {
          current: 'wrong',
          new: 'new-password',
        }),
      UserError,
      'Wrong username or password',
    );
    await assertRejects(
      () =>
        f.auth.users.setPassword(f.admin.id, f.admin.id, {
          current: 'password-admin',
          new: 'short',
        }),
      UserError,
      'password_too_short',
    );
    assertEquals((await f.auth.sessions.list(f.admin.id)).length, 2);
    await f.auth.users.setPassword(f.admin.id, f.admin.id, {
      current: 'password-admin',
      new: 'new-password',
    });
    assertEquals(await f.auth.sessions.authenticate(a.key), null);
    assertEquals(await f.auth.sessions.authenticate(b.key), null);
    assertEquals(ended.length, 1);
    assertEquals(
      ended[0].sessionIds.sort(),
      [a.session.id, b.session.id].sort(),
    );
    await assertRejects(() => f.signIn());
    assert((await f.signIn('admin', 'new-password')).key.startsWith('mfs_'));
  } finally {
    await f.close();
  }
});

Deno.test('sessions core: admin resets someone else without old password; other users stay signed in', async () => {
  const f = await authFixture();
  try {
    const user = await f.auth.users.create(f.admin.id, {
      username: 'other',
      password: 'password-other',
      role: 'user',
    });
    const own = await f.signIn(),
      other = await f.signIn('other', 'password-other');
    await assertRejects(
      () =>
        f.auth.users.setPassword(user.id, f.admin.id, {
          new: 'hacked-password',
        }),
      UserError,
      'forbidden',
    );
    await f.auth.users.setPassword(f.admin.id, user.id, {
      new: 'reset-password',
    });
    assertEquals(await f.auth.sessions.authenticate(other.key), null);
    assert((await f.auth.sessions.authenticate(own.key)) !== null);
    assert((await f.signIn('other', 'reset-password')).key.startsWith('mfs_'));
  } finally {
    await f.close();
  }
});

Deno.test('sessions core: no default expiry; idle expiry notifies once, and last-used writes are throttled', async () => {
  const f = await authFixture();
  try {
    const signed = await f.signIn();
    const ended: SessionsEnded[] = [];
    f.auth.sessions.onSessionsEnded((event) => ended.push(event));
    f.advance(59999);
    await f.auth.sessions.authenticate(signed.key);
    assertEquals(
      (await f.auth.sessions.list(f.admin.id))[0].lastUsedAt,
      signed.session.lastUsedAt,
    );
    f.advance(1);
    await f.auth.sessions.authenticate(signed.key);
    assertEquals(
      (await f.auth.sessions.list(f.admin.id))[0].lastUsedAt,
      new Date(f.now()).toISOString(),
    );
    f.advance(365 * 86400000);
    assert((await f.auth.sessions.authenticate(signed.key)) !== null);
    await f.state.set('auth.sessionIdleDays', '1');
    f.advance(86400000);
    assertEquals(await f.auth.sessions.authenticate(signed.key), null);
    assertEquals(ended, [{
      userId: f.admin.id,
      sessionIds: [signed.session.id],
    }]);
    assertEquals(await f.auth.sessions.authenticate(signed.key), null);
    assertEquals(ended.length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('sessions core: persisted keys authenticate after reopen with fresh user and session state', async () => {
  const f = await authFixture();
  let store = f.store;
  try {
    const signed = await f.signIn();
    await store.close();
    store = await openStore(f.dir);
    const auth = createAuthentication(store, f.cfg, createState(store), f.now);
    const authenticated = await auth.sessions.authenticate(signed.key);
    assertEquals([authenticated?.user.id, authenticated?.sessionId], [
      f.admin.id,
      signed.session.id,
    ]);
    await auth.users.update(f.admin.id, f.admin.id, {
      username: 'Renamed Admin',
    });
    assertEquals(
      (await auth.sessions.authenticate(signed.key))?.user.username,
      'Renamed Admin',
    );
    assertEquals(
      (await auth.sessions.list(f.admin.id))[0].deviceName,
      'Device',
    );
    await auth.sessions.revokeAll(f.admin.id);
    assertEquals(await auth.sessions.authenticate(signed.key), null);
  } finally {
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('sessions core: password reset invalidates an in-flight proof before session creation', async () => {
  const f = await authFixture();
  try {
    const old = await f.store.users.credentials({ id: f.admin.id });
    assert(old);
    await f.auth.users.setPassword(f.admin.id, f.admin.id, {
      current: 'password-admin',
      new: 'changed-password',
    });
    const coreSessions = createSessions(f.store, f.state, f.now);
    const error = await assertRejects(
      () =>
        coreSessions.create(f.admin.id, {
          deviceName: 'late',
          userAgent: 'test',
        }, old.passwordEnc),
      UserError,
    );
    assertEquals((error as UserError).code, 'invalid_credentials');
    assertEquals(await f.auth.sessions.list(f.admin.id), []);
    assertEquals(
      (await f.auth.users.get(f.admin.id, f.admin.id)).lastLoginAt,
      null,
    );
  } finally {
    await f.close();
  }
});
