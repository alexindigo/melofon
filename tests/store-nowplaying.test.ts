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
