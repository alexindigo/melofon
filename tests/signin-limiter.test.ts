import { assert, assertEquals, assertRejects } from '@std/assert';
import { authFixture } from './helpers/authentication.ts';
import { SignInError } from '../src/authentication.ts';

Deno.test('sign-in limiter: ten failures, wait doubles to cap; client-address separation and success reset', async () => {
  const f = await authFixture();
  try {
    for (const expected of [60, 120, 240, 480, 960, 1920, 3600, 3600]) {
      for (let i = 0; i < 10; i++) {
        const error = await assertRejects(
          () => f.signIn('admin', 'wrong'),
          SignInError,
        );
        assertEquals((error as SignInError).code, 'invalid_credentials');
      }
      const error = await assertRejects(() => f.signIn(), SignInError);
      assertEquals([
        (error as SignInError).code,
        (error as SignInError).retryAfterSeconds,
      ], ['too_many_attempts', expected]);
      assert(
        (await f.signIn('admin', 'password-admin', 'client-b')).key.startsWith(
          'mfs_',
        ),
      );
      f.advance(expected * 1000);
    }
    await f.signIn();
    for (let i = 0; i < 10; i++) {
      await assertRejects(() => f.signIn('ADMIN', 'wrong'), SignInError);
    }
    const reset = await assertRejects(() => f.signIn(), SignInError);
    assertEquals((reset as SignInError).retryAfterSeconds, 60);
    f.advance(1500);
    const remaining = await assertRejects(() => f.signIn(), SignInError);
    assertEquals((remaining as SignInError).retryAfterSeconds, 59);
  } finally {
    await f.close();
  }
});

Deno.test('sign-in limiter: concurrent failures cannot bypass the tenth-failure boundary', async () => {
  const f = await authFixture();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () => f.signIn('admin', 'wrong')),
    );
    assertEquals(
      results.filter((r) =>
        r.status === 'rejected' && r.reason.code === 'invalid_credentials'
      ).length,
      10,
    );
    assertEquals(
      results.filter((r) =>
        r.status === 'rejected' && r.reason.code === 'too_many_attempts'
      ).length,
      5,
    );
  } finally {
    await f.close();
  }
});

Deno.test('sign-in limiter: unknown-user failure is generic; successful native sign-in records login and metadata', async () => {
  const f = await authFixture();
  try {
    const unknown = await assertRejects(
      () => f.signIn('unknown', 'wrong'),
      SignInError,
    );
    const wrong = await assertRejects(
      () => f.signIn('admin', 'wrong'),
      SignInError,
    );
    assertEquals([(unknown as SignInError).code, unknown.message], [
      (wrong as SignInError).code,
      wrong.message,
    ]);
    const signed = await f.signIn();
    assertEquals([signed.session.deviceName, signed.session.userAgent], [
      'Device',
      'a3-test',
    ]);
    assertEquals(
      (await f.auth.sessions.authenticate(signed.key))?.user.lastLoginAt,
      new Date(f.now()).toISOString(),
    );
  } finally {
    await f.close();
  }
});

Deno.test('sign-in limiter: owner-declared settings govern thresholds and waits', async () => {
  const f = await authFixture();
  try {
    await f.state.set('auth.signInFailures', '2');
    await f.state.set('auth.signInWaitSeconds', '3');
    await f.state.set('auth.signInWaitMaxSeconds', '5');
    for (const wait of [3, 5, 5]) {
      for (let i = 0; i < 2; i++) {
        await assertRejects(() => f.signIn('admin', 'wrong'), SignInError);
      }
      const error = await assertRejects(() => f.signIn(), SignInError);
      assertEquals((error as SignInError).retryAfterSeconds, wait);
      f.advance(wait * 1000);
    }
  } finally {
    await f.close();
  }
});
