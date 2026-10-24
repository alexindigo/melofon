import { assert, assertEquals } from '@std/assert';
import { apiFixture, cleared, error, iso } from './helpers/api.ts';

Deno.test('API sign-in: directly received HTTPS sets Secure on issued and cleared cookies', async () => {
  const f = await apiFixture({ tls: true });
  try {
    const signed = await f.login();
    assert(signed.response.headers.get('set-cookie')!.includes('; Secure'));
    const me = await f.get('/api/v1/me', signed.credential);
    assertEquals(me.status, 200);
    await me.body?.cancel();
    const out = await f.json(
      '/api/v1/session',
      'DELETE',
      undefined,
      signed.credential,
    );
    assertEquals(out.status, 200);
    cleared(out);
    assert(out.headers.get('set-cookie')!.includes('; Secure'));
    await out.body?.cancel();
  } finally {
    await f.close();
  }
});

Deno.test('API sign-in: plain HTTP cookie authenticates me without exposing key in JSON', async () => {
  const f = await apiFixture();
  try {
    const signed = await f.login();
    const cookie = signed.response.headers.get('set-cookie')!;
    for (
      const flag of [
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        'Max-Age=34560000',
      ]
    ) assert(cookie.includes(flag));
    assert(!cookie.includes('Secure'));
    assert(
      !JSON.stringify(signed.body).includes(signed.credential.split('=')[1]),
    );
    assertEquals(signed.body.key, undefined);
    assertEquals(Object.keys(signed.body).sort(), ['session', 'user']);
    assertEquals(Object.keys(signed.body.session).sort(), [
      'createdAt',
      'deviceName',
      'id',
    ]);
    iso(signed.body.session.createdAt);
    iso(signed.body.user.lastLoginAt);
    const response = await f.get('/api/v1/me', signed.credential);
    assertEquals(response.status, 200);
    const me = await response.json();
    assertEquals(me, signed.body.user);
    assertEquals(Object.keys(me).sort(), [
      'displayName',
      'email',
      'id',
      'lastLoginAt',
      'role',
      'session',
      'username',
    ]);
    assertEquals(me.session, {
      id: signed.body.session.id,
      deviceName: 'Device',
    });
    const alias = await f.get('/_melofon/api/v1/me', signed.credential);
    assertEquals(await alias.json(), me);
    assertEquals(f.peers.length, 1);
    assert(
      Deno.networkInterfaces().some((item) => item.address === f.peers[0]),
    );
    assert(!['', '?', 'unknown', '127.0.0.1', '::1'].includes(f.peers[0]));
  } finally {
    await f.close();
  }
});

Deno.test('API sign-in: bearer returned once, default cookie mode, logout revokes and clears', async () => {
  const f = await apiFixture();
  try {
    const signed = await f.login('bearer');
    assert(/^mfs_[A-Za-z0-9_-]+$/.test(signed.body.key));
    assertEquals(signed.response.headers.get('set-cookie'), null);
    const me = await f.get('/api/v1/me', signed.credential);
    assertEquals(me.status, 200);
    assert(!(await me.text()).includes(signed.body.key));
    const out = await f.json(
      '/api/v1/session',
      'DELETE',
      undefined,
      signed.credential,
      null,
    );
    assertEquals(out.status, 200);
    cleared(out);
    await out.body?.cancel();
    await error(
      await f.get('/api/v1/me', signed.credential),
      401,
      'unauthenticated',
    );
    const defaultMode = await f.json('/_melofon/api/v1/session', 'POST', {
      username: 'admin',
      password: 'password-admin',
    });
    assertEquals(defaultMode.status, 200);
    assert(defaultMode.headers.has('set-cookie'));
    assertEquals((await defaultMode.json()).key, undefined);
  } finally {
    await f.close();
  }
});

Deno.test('API sign-in: generic failure and eleventh attempt retry wait ignores forwarded addresses', async () => {
  const f = await apiFixture();
  try {
    const unknown = await error(
      await f.json('/api/v1/session', 'POST', {
        username: 'absent',
        password: 'wrong',
      }),
      401,
      'invalid_credentials',
    );
    for (let i = 0; i < 10; i++) {
      const response = await f.request('/api/v1/session', {
        method: 'POST',
        headers: {
          Origin: f.origin,
          'Content-Type': 'application/json',
          'X-Forwarded-For': `192.0.2.${i}`,
        },
        body: JSON.stringify({ username: 'admin', password: 'wrong' }),
      });
      assertEquals(await error(response, 401, 'invalid_credentials'), unknown);
    }
    const limited = await f.json('/api/v1/session', 'POST', {
      username: 'ADMIN',
      password: 'password-admin',
    });
    assertEquals(limited.headers.get('retry-after'), '60');
    await error(limited, 429, 'too_many_attempts');
    assertEquals(new Set(f.peers).size, 1);
    f.advance(60000);
    const signed = await f.login();
    assert(signed.credential);
  } finally {
    await f.close();
  }
});

Deno.test('API sign-in: auth precedence and public failures stay shaped without details', async () => {
  const f = await apiFixture({ failSignIn: true });
  try {
    const response = await f.json('/api/v1/session', 'POST', {
      username: 'admin',
      password: 'password-admin',
    });
    assertEquals(await error(response, 500, 'internal_error'), {
      code: 'internal_error',
      message: 'Internal server error',
    });
  } finally {
    await f.close();
  }
  const g = await apiFixture();
  try {
    const signed = await g.login();
    await error(
      await g.get('/api/v1/me', signed.credential, {
        Authorization: 'Bearer invalid',
      }),
      401,
      'unauthenticated',
    );
    await error(
      await g.get('/api/v1/me', signed.credential, {
        Authorization: 'Basic invalid',
      }),
      401,
      'unauthenticated',
    );
  } finally {
    await g.close();
  }
});
