import { assert, assertEquals, assertRejects } from '@std/assert';
import { createNowPlayingStore } from '../src/store/nowplaying.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('store.nowPlaying.set supersedes atomically and rolls back failures', async () => {
  const t = await domainFixture(createNowPlayingStore);
  try {
    await t.domain.set('alice', "phone'", 'song', 'old', 12.9);
    const before = await t.domain.list();
    assertEquals(before[0].positionMs, 12);
    t.failCommit();
    await assertRejects(
      () => t.domain.set('alice', "phone'", 'next', 'new'),
      Error,
      'injected',
    );
    assertEquals(await t.domain.list(), before);
    await t.domain.set('alice', "phone'", 'next', 'new');
    assertEquals(
      (await t.domain.list()).map((r) => [r.trackId, r.streamId, r.positionMs]),
      [['next', 'new', null]],
    );
    await assertRejects(
      () => t.domain.set('unknown', 'phone', 'song', 'bad'),
      Error,
      'unknown user',
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.nowPlaying.clearByStreamId rejects stale streams and is atomic', async () => {
  const t = await domainFixture(createNowPlayingStore);
  try {
    await t.domain.set('alice', 'phone', 'song', 'current');
    assertEquals(await t.domain.clearByStreamId('stale'), false);
    t.failCommit();
    await assertRejects(
      () => t.domain.clearByStreamId('current'),
      Error,
      'injected',
    );
    assertEquals((await t.domain.list()).length, 1);
    assertEquals(await t.domain.clearByStreamId('current'), true);
    assertEquals(await t.domain.list(), []);
  } finally {
    await t.close();
  }
});

Deno.test('store.nowPlaying.list includes every user and maps epoch milliseconds', async () => {
  const t = await domainFixture(createNowPlayingStore);
  try {
    await t.domain.set('alice', 'phone', 'song', 'a');
    await t.domain.set('bob', 'desktop', 'song', 'b');
    const rows = await t.domain.list();
    assertEquals(rows.map((r) => r.username), ['bob', 'alice']);
    assert(rows.every((r) => Number.isFinite(r.startedAtMs)));
  } finally {
    await t.close();
  }
});

Deno.test('store.nowPlaying reads and expired stop claims never silently remove rows', async () => {
  const t = await domainFixture(createNowPlayingStore);
  try {
    await t.domain.set('alice', 'phone', 'song', 'report', 100, {
      state: 'paused',
      reportedAtMs: 1000,
      playbackRate: 1,
      durationMs: 1000,
      restart: true,
    });
    const before = await t.domain.list();
    const expiry = { plannedBeforeMs: 1000, pausedBeforeMs: 1000 };
    assertEquals(await t.domain.list(expiry), []);
    assertEquals(await t.domain.list(), before, 'a projection must not delete');
    assertEquals(await t.domain.finish('alice', 'phone', 'song', expiry), null);
    assertEquals(await t.domain.list(), before, 'an expired stop cannot claim');
  } finally {
    await t.close();
  }
});

Deno.test('store.nowPlaying expiry is atomic, shares all deadline rules and retains player identities', async () => {
  const t = await domainFixture(createNowPlayingStore);
  try {
    await t.run("UPDATE files SET duration_ms = 1000 WHERE id = 'song'");
    for (const state of ['starting', 'playing', 'paused'] as const) {
      await t.domain.set('alice', state, 'song', state, 200, {
        state,
        playbackRate: 2,
        reportedAtMs: 1000,
        durationMs: null,
        restart: true,
      });
    }
    // No known duration falls back to zero remaining time, not a new lease.
    await t.domain.set('bob', 'unknown', 'missing', 'unknown', 0, {
      state: 'playing',
      playbackRate: 1,
      reportedAtMs: 1000,
      durationMs: null,
      restart: true,
    });
    const before = await t.domain.list();
    const deadlines = { plannedBeforeMs: 1400, pausedBeforeMs: 1000 };
    assertEquals(
      (await t.domain.list({ plannedBeforeMs: 999, pausedBeforeMs: 999 }))
        .length,
      4,
    );
    assertEquals(
      (await t.domain.list({ plannedBeforeMs: 1399, pausedBeforeMs: 999 }))
        .length,
      3,
    );
    assertEquals(await t.domain.list(deadlines), []);
    assertEquals(await t.domain.list(), before);
    t.failCommit();
    await assertRejects(() => t.domain.expire(deadlines), Error, 'injected');
    assertEquals(await t.domain.list(), before, 'failed removal is retryable');
    assertEquals(
      await Promise.all([
        t.domain.expire(deadlines),
        t.domain.expire(deadlines),
      ]),
      [4, 0],
    );
    assertEquals(await t.domain.list(), []);
    assertEquals((await t.all('SELECT * FROM client_players')).length, 4);
    assertEquals(await t.all('SELECT * FROM listens'), []);
    await t.domain.set('alice', 'playing', 'song', 'again', 0);
    assertEquals(
      (await t.domain.list())[0].playerId,
      before.find((r) => r.client === 'playing')!.playerId,
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.nowPlaying a refreshed report supersedes expiry without a silent purge', async () => {
  const t = await domainFixture(createNowPlayingStore);
  try {
    const update = {
      state: 'paused' as const,
      playbackRate: 1,
      reportedAtMs: 1000,
      durationMs: 1000,
      restart: false,
    };
    await t.domain.set('alice', 'phone', 'song', 'first', 10, update);
    const playerId = (await t.domain.list())[0].playerId;
    await t.domain.set('alice', 'phone', 'song', 'live', 20, {
      ...update,
      reportedAtMs: 2000,
    }, { plannedBeforeMs: 999, pausedBeforeMs: 999 });
    assertEquals((await t.domain.list())[0].startedAtMs, 1000);
    assertEquals(
      await t.domain.expire({ plannedBeforeMs: 1000, pausedBeforeMs: 1000 }),
      0,
    );
    await t.domain.set('alice', 'phone', 'song', 'new-run', 0, {
      ...update,
      reportedAtMs: 3000,
    }, { plannedBeforeMs: 2000, pausedBeforeMs: 2000 });
    const row = (await t.domain.list())[0];
    assertEquals(
      row.startedAtMs,
      3000,
      'expired same-song report starts afresh',
    );
    assertEquals(row.playerId, playerId);
    assertEquals(
      await t.domain.expire({ plannedBeforeMs: 2000, pausedBeforeMs: 2000 }),
      0,
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.nowPlaying finish rolls back claim and append together and serializes competing stops', async () => {
  const t = await domainFixture(createNowPlayingStore);
  try {
    await t.domain.set('alice', 'phone', 'song', 'run', 500, {
      state: 'paused',
      playbackRate: 1,
      reportedAtMs: 1000,
      durationMs: 1000,
      restart: true,
    });
    const before = await t.domain.list();
    const expiry = { plannedBeforeMs: 0, pausedBeforeMs: 0 };
    const listen = { source: 'melofon', playedAtMs: 2000, durationMs: 1000 };
    t.failCommit();
    await assertRejects(
      () => t.domain.finish('alice', 'phone', 'song', expiry, listen),
      Error,
      'injected',
    );
    assertEquals(await t.domain.list(), before);
    assertEquals(
      await t.all('SELECT * FROM listens'),
      [],
      'append must roll back too',
    );
    const result = await Promise.all([
      t.domain.finish('alice', 'phone', 'song', expiry, listen),
      t.domain.finish('alice', 'phone', 'song', expiry, listen),
    ]);
    assertEquals(result, [before[0], null]);
    assertEquals(await t.domain.list(), []);
    assertEquals(
      await t.all(`SELECT user_id, track_id, source, duration_ms,
      epoch_ms(played_at) AS at FROM listens`),
      [{
        user_id: 'u',
        track_id: 'song',
        source: 'melofon',
        duration_ms: 1000,
        at: 2000,
      }],
    );
    await t.domain.set('alice', 'phone', 'song', 'next');
    assertEquals((await t.domain.list())[0].playerId, before[0].playerId);
  } finally {
    await t.close();
  }
});

Deno.test('store.nowPlaying finish never counts stale or expired claims and missing catalog cannot consume a retry', async () => {
  const t = await domainFixture(createNowPlayingStore);
  try {
    const update = {
      state: 'paused' as const,
      playbackRate: 1,
      reportedAtMs: 1000,
      durationMs: 1000,
      restart: true,
    };
    await t.domain.set('alice', 'phone', 'song', 'run', 0, update);
    const before = await t.domain.list();
    const expiry = { plannedBeforeMs: 0, pausedBeforeMs: 0 };
    const listen = { source: 'opensubsonic', durationMs: 1000 };
    assertEquals(
      await t.domain.finish('alice', 'phone', 'other', expiry, listen),
      null,
    );
    assertEquals(
      await t.domain.finish('bob', 'phone', 'song', expiry, listen),
      null,
    );
    assertEquals(
      await t.domain.finish('alice', 'phone', 'song', {
        ...expiry,
        pausedBeforeMs: 1000,
      }, listen),
      null,
    );
    assertEquals(await t.domain.list(), before);
    await t.run("DELETE FROM files WHERE id = 'song'");
    await assertRejects(
      () => t.domain.finish('alice', 'phone', 'song', expiry, listen),
      Error,
      'Unknown track',
    );
    assertEquals(await t.domain.list(), before);
    assertEquals(await t.all('SELECT * FROM listens'), []);
    // Non-counting stops can still remove their matching live row.
    assertEquals(
      await t.domain.finish('alice', 'phone', 'song', expiry),
      before[0],
    );
    assertEquals(await t.domain.list(), []);
    assertEquals(await t.all('SELECT * FROM listens'), []);
  } finally {
    await t.close();
  }
});
