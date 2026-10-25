import { assert, assertEquals, assertRejects } from '@std/assert';
import { authFixture } from './helpers/authentication.ts';
import { SignInError } from '../src/authentication.ts';
import { createSignInLimiter } from '../src/signin-limiter.ts';

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

Deno.test('sign-in limiter: both reads and failures sweep idle entries while retaining active windows', async () => {
  const f = await authFixture();
  const originalDelete = Map.prototype.delete;
  const deleted: string[] = [];
  try {
    await f.state.set('auth.signInFailures', '2');
    await f.state.set('auth.signInWaitSeconds', '3');
    const limiter = createSignInLimiter(f.state, f.now);
    // Observe actual eviction without exposing the limiter's private map in production.
    Map.prototype.delete = function (key) {
      if (typeof key === 'string' && key.startsWith('["expiry-')) {
        deleted.push(key);
      }
      return originalDelete.call(this, key);
    };
    const key = (name: string) =>
      JSON.stringify([`expiry-${name}`, 'client-a']);
    const fail = (name: string) =>
      limiter.failure(`expiry-${name}`, 'client-a');
    const remaining = (name: string) =>
      limiter.remaining(`expiry-${name}`, 'client-a');
    for (let i = 0; i < 100; i++) await fail(`idle-${i}`);
    await fail('locked');
    await fail('locked');
    f.advance(2000);
    await fail('recent');
    f.advance(1001);
    assertEquals(remaining('locked'), 0);
    for (let i = 0; i < 100; i++) assert(deleted.includes(key(`idle-${i}`)));
    assert(!deleted.includes(key('locked')));
    assert(!deleted.includes(key('recent')));
    // Retained counts and backoff are observable at the attempt boundary.
    await fail('recent');
    assertEquals(remaining('recent'), 3);
    await fail('locked');
    await fail('locked');
    assertEquals(remaining('locked'), 6);
    await fail('failure-sweep');
    f.advance(3001);
    const before = deleted.length;
    await fail('fresh');
    assert(deleted.slice(before).includes(key('failure-sweep')));
    assertEquals(remaining('locked'), 3);
    assert(!deleted.includes(key('locked')));
    f.advance(10000);
    remaining('fresh');
    assert(deleted.includes(key('locked')));
    assert(deleted.includes(key('recent')));
    assert(deleted.includes(key('fresh')));
    await fail('locked');
    assertEquals(remaining('locked'), 0);
    await fail('locked');
    assertEquals(
      remaining('locked'),
      3,
      'expired history starts at the initial wait',
    );
  } finally {
    Map.prototype.delete = originalDelete;
    await f.close();
  }
});

Deno.test('sign-in limiter: 10,000 distinct entries sweep at most once per interval', async () => {
  const f = await authFixture();
  const originalIterator = Map.prototype[Symbol.iterator];
  const originalDelete = Map.prototype.delete;
  let tracked: Map<unknown, unknown> | undefined;
  let sweeps = 0;
  let deleted = 0;
  const key = (name: string) => JSON.stringify([`bounded-${name}`, 'client-a']);
  try {
    await f.state.set('auth.signInWaitSeconds', '1');
    const limiter = createSignInLimiter(f.state, f.now);
    Map.prototype[Symbol.iterator] = function () {
      if (this.has(key('idle-0'))) tracked = this;
      if (this === tracked) sweeps++;
      return originalIterator.call(this);
    };
    Map.prototype.delete = function (key) {
      if (this === tracked) deleted++;
      return originalDelete.call(this, key);
    };
    for (let i = 0; i < 10_000; i++) {
      await limiter.failure(`bounded-idle-${i}`, 'client-a');
    }
    f.advance(999);
    for (let i = 0; i < 100; i++) {
      assertEquals(limiter.remaining('bounded-idle-0', 'client-a'), 0);
      await limiter.failure('bounded-fresh', 'client-a');
    }
    assertEquals(sweeps, 0, 'attempts within the interval never walk the map');
    f.advance(1);
    limiter.remaining('bounded-fresh', 'client-a');
    assertEquals(sweeps, 1);
    assertEquals(deleted, 10_000, 'the interval sweep removes expired entries');
    await limiter.failure('bounded-next', 'client-a');
    limiter.remaining('bounded-next', 'client-a');
    assertEquals(sweeps, 1);
    f.advance(1000);
    await limiter.failure('bounded-next', 'client-a');
    assertEquals(sweeps, 2, 'failures also trigger the next interval sweep');
    limiter.remaining('bounded-next', 'client-a');
    assertEquals(sweeps, 2);
  } finally {
    Map.prototype[Symbol.iterator] = originalIterator;
    Map.prototype.delete = originalDelete;
    await f.close();
  }
});

Deno.test('sign-in limiter: expired unswept counts and backoff behave as absent on reads and failures', async () => {
  const f = await authFixture();
  try {
    await f.state.set('auth.signInFailures', '2');
    await f.state.set('auth.signInWaitSeconds', '3');
    for (const readFirst of [false, true]) {
      const limiter = createSignInLimiter(f.state, f.now);
      const fail = (name: string) => limiter.failure(name, 'client-a');
      const remaining = (name: string) => limiter.remaining(name, 'client-a');
      await fail('idle');
      await fail('locked');
      await fail('locked');
      f.advance(2500);
      remaining('unrelated');
      f.advance(500);
      if (readFirst) assertEquals(remaining('idle'), 0);
      await fail('idle');
      assertEquals(remaining('idle'), 0, 'expired failure count resets');
      await fail('idle');
      assertEquals(remaining('idle'), 3);
      // A lockout that just ended is still inside its idle retention window.
      await fail('locked');
      await fail('locked');
      assertEquals(remaining('locked'), 6);
      f.advance(11_500);
      remaining('unrelated');
      f.advance(500);
      if (readFirst) assertEquals(remaining('locked'), 0);
      await fail('locked');
      assertEquals(remaining('locked'), 0);
      await fail('locked');
      assertEquals(remaining('locked'), 3, 'expired backoff resets to initial');
    }
  } finally {
    await f.close();
  }
});
