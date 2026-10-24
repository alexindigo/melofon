import { assert, assertEquals } from '@std/assert';
import { apiFixture, cleared, error, iso } from './helpers/api.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';

Deno.test('API admin: create, read, rename, uniqueness, roles and last-admin invariant', async () => {
  const f = await apiFixture();
  try {
    const admin = await f.login('bearer');
    const created = await f.json('/api/v1/admin/users', 'POST', {
      username: 'Reader',
      password: 'password-reader',
      displayName: 'A reader',
      email: 'reader@example.test',
    }, admin.credential);
    assertEquals(created.status, 201);
    const user = await created.json();
    assertEquals(typeof user.id, 'string');
    assertEquals(user.role, 'user');
    iso(user.createdAt);
    const signed = await f.login('bearer', 'reader', 'password-reader');
    assertEquals(signed.body.user.id, user.id);
    let response = await f.get(
      `/api/v1/admin/users/${user.id}`,
      admin.credential,
    );
    assertEquals((await response.json()).email, 'reader@example.test');
    response = await f.json(`/api/v1/admin/users/${user.id}`, 'PATCH', {
      username: 'Renamed',
      role: 'admin',
    }, admin.credential);
    assertEquals(response.status, 200);
    assertEquals((await response.json()).username, 'Renamed');
    response = await f.get('/api/v1/me', signed.credential);
    let me = await response.json();
    assertEquals(me.username, 'Renamed');
    assertEquals(me.role, 'admin');
    response = await f.get('/api/v1/admin/users', signed.credential);
    const { users } = await response.json();
    assertEquals(users.length, 2);
    assertEquals(
      users.map((u: { id: string }) => u.id).sort(),
      [f.admin.id, user.id].sort(),
    );
    await error(
      await f.json('/api/v1/admin/users', 'POST', {
        username: 'RENAMED',
        password: 'password-reader',
      }, admin.credential),
      409,
      'name_taken',
    );
    await error(
      await f.json(`/api/v1/admin/users/${user.id}`, 'PATCH', {
        username: 'ADMIN',
      }, admin.credential),
      409,
      'name_taken',
    );
    response = await f.json(`/api/v1/admin/users/${user.id}`, 'PATCH', {
      role: 'user',
    }, admin.credential);
    assertEquals(response.status, 200);
    await response.body?.cancel();
    await error(
      await f.get('/api/v1/admin/users', signed.credential),
      403,
      'forbidden',
    );
    await error(
      await f.json(`/api/v1/admin/users/${f.admin.id}`, 'PATCH', {
        role: 'user',
      }, admin.credential),
      409,
      'last_admin',
    );
    response = await f.json('/api/v1/me', 'PATCH', {
      displayName: 'Changed',
      email: null,
    }, signed.credential);
    me = await response.json();
    assertEquals(me.displayName, 'Changed');
    assertEquals(me.email, null);
    await error(
      await f.json('/api/v1/me', 'PATCH', { role: 'admin' }, signed.credential),
      400,
      'unknown_field',
    );
    await error(
      await f.json(
        '/api/v1/me',
        'PATCH',
        { username: 'Forbidden' },
        signed.credential,
      ),
      400,
      'unknown_field',
    );
    await error(
      await f.json(
        `/api/v1/admin/users/${user.id}`,
        'DELETE',
        undefined,
        admin.credential,
      ),
      405,
      'method_not_allowed',
    );
    await error(
      await f.get('/api/v1/admin/users/missing', admin.credential),
      404,
      'not_found',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API admin: all admin routes and misses require fresh admin authorization before body parsing', async () => {
  const f = await apiFixture();
  try {
    const user = await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const signed = await f.login('bearer', 'reader', 'password-reader');
    for (
      const [method, path] of [
        ['GET', '/admin/users'],
        ['POST', '/admin/users'],
        ['GET', `/admin/users/${user.id}`],
        ['PATCH', `/admin/users/${user.id}`],
        ['PUT', `/admin/users/${user.id}/password`],
        ['GET', `/admin/users/${user.id}/sessions`],
        ['DELETE', `/admin/users/${user.id}/sessions`],
        ['GET', '/admin/unknown'],
      ]
    ) {
      await error(
        await f.json(`/api/v1${path}`, method, undefined, signed.credential),
        403,
        'forbidden',
      );
      await error(
        await f.json(`/api/v1${path}`, method, undefined),
        401,
        'unauthenticated',
      );
    }
    await error(await f.get('/api/v1/unknown'), 404, 'not_found');
    await error(await f.get('/api/v1/session/unknown'), 404, 'not_found');
    await error(await f.get('/api/v1/me/unknown'), 401, 'unauthenticated');
    await error(
      await f.get('/_melofon/api/v1/admin/unknown', signed.credential),
      403,
      'forbidden',
    );
    await error(
      await f.json('/api/v1/session', 'DELETE', undefined),
      401,
      'unauthenticated',
    );
    const method = await f.json('/api/v1/me', 'POST', {}, signed.credential);
    assert(method.headers.get('allow')!.includes('GET'));
    assert(method.headers.get('allow')!.includes('PATCH'));
    await error(method, 405, 'method_not_allowed');
  } finally {
    await f.close();
  }
});

Deno.test('API admin: reset and revoke sessions affect only the target user', async () => {
  const f = await apiFixture();
  try {
    const user = await f.auth.users.create(f.admin.id, {
      username: 'reader',
      password: 'password-reader',
      role: 'user',
    });
    const admin = await f.login('cookie');
    const a = await f.login('cookie', 'reader', 'password-reader', 'Phone');
    const b = await f.login('bearer', 'reader', 'password-reader', 'Tablet');
    let response = await f.get(
      `/api/v1/admin/users/${user.id}/sessions`,
      admin.credential,
    );
    const { sessions } = await response.json();
    assertEquals(sessions.length, 2);
    assert(sessions.every((s: { current: boolean }) => !s.current));
    response = await f.json(`/api/v1/admin/users/${user.id}/password`, 'PUT', {
      new: 'password-reset',
    }, admin.credential);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('set-cookie'), null);
    await response.body?.cancel();
    for (const signed of [a, b]) {
      await error(
        await f.get('/api/v1/me', signed.credential),
        401,
        'unauthenticated',
      );
    }
    response = await f.get('/api/v1/me', admin.credential);
    assertEquals(response.status, 200);
    await response.body?.cancel();
    const c = await f.login('bearer', 'reader', 'password-reset');
    response = await f.json(
      `/api/v1/admin/users/${user.id}/sessions`,
      'DELETE',
      undefined,
      admin.credential,
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    await error(
      await f.get('/api/v1/me', c.credential),
      401,
      'unauthenticated',
    );
    // a3 expressly requires current-password proof for self changes, including admins.
    await error(
      await f.json(`/api/v1/admin/users/${f.admin.id}/password`, 'PUT', {
        new: 'password-reset',
      }, admin.credential),
      401,
      'invalid_credentials',
    );
    response = await f.json(
      `/api/v1/admin/users/${f.admin.id}/sessions`,
      'DELETE',
      undefined,
      admin.credential,
    );
    assertEquals(response.status, 200);
    cleared(response);
    await response.body?.cancel();
    await error(
      await f.get('/api/v1/me', admin.credential),
      401,
      'unauthenticated',
    );
  } finally {
    await f.close();
  }
});

Deno.test('API JSON: malformed UTF-8/JSON/non-object, media type, size, unknown fields and input types', async () => {
  const f = await apiFixture();
  try {
    const signed = await f.login('bearer');
    for (
      const body of [
        '{bad',
        '[]',
        'null',
        '42',
        '',
        new Uint8Array([0xc3, 0x28]),
      ]
    ) {
      await error(
        await f.request('/api/v1/me', {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${signed.credential}`,
            Origin: f.origin,
            'Content-Type': 'application/json',
          },
          body,
        }),
        400,
        'not_json',
      );
    }
    await error(
      await f.request('/api/v1/me', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${signed.credential}`,
          Origin: f.origin,
          'Content-Type': 'text/plain',
        },
        body: '{}',
      }),
      415,
      'unsupported_media_type',
    );
    await error(
      await f.json(
        '/api/v1/me',
        'PATCH',
        { displayName: 'x'.repeat(65536) },
        signed.credential,
      ),
      413,
      'too_large',
    );
    // Content-Length is rejected before content type or JSON decoding.
    await error(
      await f.request('/api/v1/me', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${signed.credential}`,
          Origin: f.origin,
          'Content-Type': 'text/plain',
        },
        body: 'x'.repeat(65537),
      }),
      413,
      'too_large',
    );
    const bytes = new TextEncoder().encode(
      JSON.stringify({ displayName: 'x'.repeat(65536) }),
    );
    await error(
      await f.request('/api/v1/me', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${signed.credential}`,
          Origin: f.origin,
          'Content-Type': 'application/json',
        },
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes.subarray(0, 30000));
            c.enqueue(bytes.subarray(30000));
            c.close();
          },
        }),
      }),
      413,
      'too_large',
    );
    for (
      const [path, method, body] of [
        ['/session', 'POST', {
          username: 'admin',
          password: 'password-admin',
          unknown: true,
        }],
        ['/me', 'PATCH', { extra: true }],
        ['/me/password', 'PUT', { current: 'x', new: 'x', extra: true }],
        ['/admin/users', 'POST', {
          username: 'a',
          password: 'password-a',
          extra: true,
        }],
        [`/admin/users/${f.admin.id}`, 'PATCH', { extra: true }],
        [`/admin/users/${f.admin.id}/password`, 'PUT', {
          new: 'password-a',
          extra: true,
        }],
      ] as const
    ) {
      await error(
        await f.json(`/api/v1${path}`, method, body, signed.credential),
        400,
        'unknown_field',
      );
    }
    for (const body of [{ displayName: 42 }, { email: [] }]) {
      await error(
        await f.json('/api/v1/me', 'PATCH', body, signed.credential),
        400,
        'invalid_field',
      );
    }
    await error(
      await f.json('/api/v1/admin/users', 'POST', {
        username: 'a',
        password: 'password-a',
        role: 'root',
      }, signed.credential),
      400,
      'invalid_field',
    );
    await error(
      await f.json('/api/v1/session', 'POST', {
        username: 'admin',
        password: 'password-admin',
        use: 'query',
      }),
      400,
      'invalid_field',
    );
    await error(
      await f.json('/api/v1/session', 'POST', {
        username: 'admin',
        password: 'password-admin',
        use: null,
      }),
      400,
      'invalid_field',
    );
    const ok = await f.request('/api/v1/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${signed.credential}`,
        Origin: f.origin,
        'Content-Type': 'Application/JSON; charset=utf-8',
      },
      body: '{}',
    });
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
  } finally {
    await f.close();
  }
});

Deno.test('API hats: hats-002 activates fresh and BASE-upgraded installs only once', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-api-upgrade-' });
  let store = await openStore(dir);
  try {
    assert(
      (await store.hats.list()).some((h) => h.name === 'melofon' && h.active),
    );
    const q = rawSql(store);
    // Reproduce BASE: the shared ledger and other flags exist, but this release does not.
    await q.run("DELETE FROM migrations WHERE id = 'hats-002'");
    await q.run("DELETE FROM hats WHERE name = 'melofon'");
    await store.hats.set('share', false);
    await store.close();
    store = await openStore(dir);
    assertEquals((await store.hats.list()).find((h) => h.name === 'melofon'), {
      name: 'melofon',
      active: true,
    });
    assertEquals(
      (await store.hats.list()).find((h) => h.name === 'share')?.active,
      false,
    );
    const receipts = await rawSql(store).all(
      "SELECT id, epoch_ms(applied_at) AS at FROM migrations WHERE id = 'hats-002'",
    );
    assertEquals(receipts.length, 1);
    await store.hats.set('melofon', false);
    await store.close();
    store = await openStore(dir);
    assertEquals(
      (await store.hats.list()).find((h) => h.name === 'melofon')?.active,
      false,
    );
    assertEquals(
      await rawSql(store).all(
        "SELECT id, epoch_ms(applied_at) AS at FROM migrations WHERE id = 'hats-002'",
      ),
      receipts,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
