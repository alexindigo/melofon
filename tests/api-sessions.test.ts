import { assertEquals } from '@std/assert';
import { apiFixture, cleared, error, iso } from './helpers/api.ts';

Deno.test('API sessions: two devices, selective revoke, ownership, and sign out everywhere', async () => {
  const f = await apiFixture();
  try {
    const a = await f.login('cookie', 'admin', 'password-admin', 'Phone');
    const b = await f.login('bearer', 'admin', 'password-admin', 'Tablet');
    const listed = await f.get('/api/v1/me/sessions', a.credential);
    const { sessions } = await listed.json();
    assertEquals(sessions.length, 2);
    for (const session of sessions) {
      assertEquals(Object.keys(session).sort(), [
        'createdAt',
        'current',
        'deviceName',
        'id',
        'lastUsedAt',
        'userAgent',
      ]);
      iso(session.createdAt);
      iso(session.lastUsedAt);
      assertEquals(session.current, session.id === a.body.session.id);
      assertEquals(session.userAgent, 'Melofon API test');
    }
    let response = await f.json(
      `/api/v1/me/sessions/${b.body.session.id}`,
      'DELETE',
      undefined,
      a.credential,
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('set-cookie'), null);
    await response.body?.cancel();
    await error(
      await f.get('/api/v1/me', b.credential),
      401,
      'unauthenticated',
    );
    response = await f.get('/api/v1/me', a.credential);
    assertEquals(response.status, 200);
    await response.body?.cancel();
    const c = await f.login('bearer');
    response = await f.json(
      '/api/v1/me/sessions',
      'DELETE',
      undefined,
      a.credential,
    );
    assertEquals(response.status, 200);
    cleared(response);
    await response.body?.cancel();
    for (const credential of [a.credential, c.credential]) {
      await error(
        await f.get('/api/v1/me', credential),
        401,
        'unauthenticated',
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('API password: re-proof and minimum; success ends current and other sessions, new password signs in', async () => {
  const f = await apiFixture();
  try {
    const a = await f.login();
    const b = await f.login('bearer');
    await error(
      await f.json('/api/v1/me/password', 'PUT', {
        current: 'wrong',
        new: 'password-next',
      }, a.credential),
      401,
      'invalid_credentials',
    );
    await error(
      await f.json('/api/v1/me/password', 'PUT', {
        current: 'password-admin',
        new: 'short',
      }, a.credential),
      400,
      'password_too_short',
    );
    const response = await f.json('/api/v1/me/password', 'PUT', {
      current: 'password-admin',
      new: 'password-next',
    }, a.credential);
    assertEquals(response.status, 200);
    cleared(response);
    await response.body?.cancel();
    for (const signed of [a, b]) {
      await error(
        await f.get('/api/v1/me', signed.credential),
        401,
        'unauthenticated',
      );
    }
    await error(
      await f.json('/api/v1/session', 'POST', {
        username: 'admin',
        password: 'password-admin',
      }),
      401,
      'invalid_credentials',
    );
    const next = await f.login('cookie', 'admin', 'password-next');
    assertEquals(next.body.user.username, 'admin');
  } finally {
    await f.close();
  }
});

Deno.test('API sessions: regular user cannot revoke another user session; deleting current clears cookie', async () => {
  const f = await apiFixture();
  try {
    await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const admin = await f.login('bearer');
    const user = await f.login('cookie', 'reader', 'password-reader');
    await error(
      await f.json(
        `/api/v1/me/sessions/${admin.body.session.id}`,
        'DELETE',
        undefined,
        user.credential,
      ),
      403,
      'forbidden',
    );
    const response = await f.json(
      `/api/v1/me/sessions/${user.body.session.id}`,
      'DELETE',
      undefined,
      user.credential,
    );
    assertEquals(response.status, 200);
    cleared(response);
    await response.body?.cancel();
    await error(
      await f.get('/api/v1/me', user.credential),
      401,
      'unauthenticated',
    );
    const alive = await f.get('/api/v1/me', admin.credential);
    assertEquals(alive.status, 200);
    await alive.body?.cancel();
  } finally {
    await f.close();
  }
});
