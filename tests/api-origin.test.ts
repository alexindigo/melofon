import { assertEquals } from '@std/assert';
import { apiFixture, error } from './helpers/api.ts';

Deno.test('API Origin: cookie writes require own origin, bearer may omit it, reads are unchecked', async () => {
  const f = await apiFixture();
  try {
    const cookie = await f.login();
    const bearer = await f.login('bearer');
    for (const origin of ['http://evil.melofon.home', 'null', null]) {
      await error(
        await f.json(
          '/api/v1/me',
          'PATCH',
          { displayName: 'Rejected' },
          cookie.credential,
          origin,
        ),
        403,
        'origin',
      );
    }
    let response = await f.json('/api/v1/me', 'PATCH', {
      displayName: 'Same origin',
    }, cookie.credential);
    assertEquals(response.status, 200);
    assertEquals((await response.json()).displayName, 'Same origin');
    response = await f.json(
      '/api/v1/me',
      'PATCH',
      { displayName: 'Native app' },
      bearer.credential,
      null,
    );
    assertEquals(response.status, 200);
    assertEquals((await response.json()).displayName, 'Native app');
    await error(
      await f.json(
        '/api/v1/me',
        'PATCH',
        { displayName: 'Rejected' },
        bearer.credential,
        'http://evil.melofon.home',
      ),
      403,
      'origin',
    );
    await error(
      await f.json('/api/v1/me', 'PATCH', {}, bearer.credential, 'null'),
      403,
      'origin',
    );
    response = await f.get('/api/v1/me', cookie.credential, {
      Origin: 'http://evil.melofon.home',
    });
    assertEquals(response.status, 200);
    assertEquals((await response.json()).displayName, 'Native app');
    response = await f.request('/api/v1/me', {
      method: 'HEAD',
      headers: { Cookie: cookie.credential, Origin: 'null' },
    });
    // Pathfinder has no automatic HEAD-to-GET fallback. The method outcome,
    // rather than an Origin failure, proves HEAD skips the Origin check.
    assertEquals(response.status, 405);
    await response.body?.cancel();
    response = await f.request('/api/v1/me', {
      method: 'OPTIONS',
      headers: {
        Cookie: cookie.credential,
        Origin: 'http://evil.melofon.home',
      },
    });
    assertEquals(response.status, 204);
    await response.body?.cancel();
  } finally {
    await f.close();
  }
});

Deno.test('API Origin: public sign-in also requires origin and forwarded headers grant no trust', async () => {
  const f = await apiFixture();
  try {
    for (const origin of [null, 'null', 'http://evil.melofon.home']) {
      await error(
        await f.json(
          '/api/v1/session',
          'POST',
          { username: 'admin', password: 'password-admin' },
          undefined,
          origin,
        ),
        403,
        'origin',
      );
    }
    const response = await f.request('/api/v1/session', {
      method: 'POST',
      headers: {
        Origin: 'https://proxy.example',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'proxy.example',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    await error(response, 403, 'origin');
    const signed = await f.request('/api/v1/session', {
      method: 'POST',
      headers: {
        Origin: f.origin,
        'X-Forwarded-Proto': 'https',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username: 'admin', password: 'password-admin' }),
    });
    assertEquals(signed.status, 200);
    assertEquals(signed.headers.get('set-cookie')!.includes('Secure'), false);
    await signed.body?.cancel();
  } finally {
    await f.close();
  }
});
