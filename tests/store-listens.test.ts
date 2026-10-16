import { assertEquals, assertRejects } from '@std/assert';
import { createListensStore } from '../src/store/listens.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('store.listens.record appends catalog listens atomically and rejects missing tracks', async () => {
  const t = await domainFixture(createListensStore);
  try {
    assertEquals(
      await t.domain.record('alice', 'missing', { source: 'test' }),
      false,
    );
    t.failCommit();
    await assertRejects(
      () => t.domain.record('alice', 'song', { source: 'lost' }),
      Error,
      'injected',
    );
    assertEquals(await t.all('SELECT track_id FROM listens'), []);
    assertEquals(
      await t.domain.record('alice', 'song', {
        source: "phone'",
        playedAtMs: 2000,
        durationMs: 123.9,
      }),
      true,
    );
    assertEquals(
      await t.domain.record('alice', 'song', {
        source: 'again',
        playedAtMs: 3000,
      }),
      true,
    );
    assertEquals(
      await t.all('SELECT source, duration_ms FROM listens ORDER BY played_at'),
      [{ source: "phone'", duration_ms: 123 }, {
        source: 'again',
        duration_ms: null,
      }],
    );
    await assertRejects(
      () => t.domain.record('unknown', 'song', { source: 'test' }),
      Error,
      'unknown user',
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.listens.facts aggregates each kind, isolates users and preserves missing defaults', async () => {
  const t = await domainFixture(createListensStore);
  try {
    await t.domain.record('alice', 'song', {
      source: 'test',
      playedAtMs: 2000,
    });
    await t.domain.record('alice', 'song', {
      source: 'test',
      playedAtMs: 3000,
    });
    await t.domain.record('bob', 'song', { source: 'test', playedAtMs: 4000 });
    const play = { playCount: 2, lastPlayedMs: 3000 };
    assertEquals(
      await t.domain.facts('alice', {
        songs: ['song', 'missing', 'song'],
        albums: ['album'],
        artists: ['artist'],
      }),
      {
        songs: { song: play, missing: { playCount: 0, lastPlayedMs: null } },
        albums: { album: play },
        artists: { artist: play },
      },
    );
    assertEquals(await t.domain.facts('alice', {}), {
      songs: {},
      albums: {},
      artists: {},
    });
  } finally {
    await t.close();
  }
});
