import { assert, assertEquals, assertRejects } from '@std/assert';
import { createPlaybackStore } from '../src/store/playback.ts';
import { domainFixture } from './helpers/store.ts';
import { songQueue } from './helpers/queue.ts';
import { stopped } from './helpers/queue.ts';
import { openStore } from '../src/store/index.ts';
import { rawSql } from '../src/store/testing.ts';

Deno.test('store.playback.saveQueue replaces zero-based positions, preserves duplicates and orphan ids, and clears', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    await t.domain.saveQueue(1, songQueue(['old']));
    const queue = songQueue(["missing'", 'song', "missing'"]);
    await t.domain.saveQueue(1, queue);
    assertEquals(await t.domain.loadQueue(1), queue);
    assertEquals(await t.all('SELECT pos FROM server_queue ORDER BY pos'), [
      { pos: 0 },
      { pos: 1 },
      { pos: 2 },
    ]);
    await t.domain.saveQueue(1, songQueue([]));
    assertEquals(await t.domain.loadQueue(1), { ...songQueue([]), nextId: 4 });
  } finally {
    await t.close();
  }
});

Deno.test('store.playback.loadQueue returns empty or typed references ordered by position', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    assertEquals(await t.domain.loadQueue(1), songQueue([]));
    await t.run(
      "INSERT INTO server_queue VALUES (1, 8, 3, 'song', 'last'), (1, 2, 1, 'song', 'first'), (1, 5, 2, 'song', 'middle')",
    );
    await t.run('UPDATE server_queue_state SET version = 1');
    await t.run('UPDATE server_queue_allocator SET next_id = 4');
    assertEquals(
      await t.domain.loadQueue(1),
      songQueue(['first', 'middle', 'last']),
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.playback.saveState upserts the player, truncates positions and records fresh epoch milliseconds', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    const before = Date.now();
    const snapshot = {
      state: 'play' as const,
      currentIndex: 2.9,
      positionMs: 12345678901.9,
      repeat: 'single' as const,
      shuffle: true,
      consume: true,
    };
    await t.domain.saveState(1, snapshot);
    const saved = (await t.domain.loadPlayerState(1))!;
    assert(saved.updatedAtMs >= before && saved.updatedAtMs <= Date.now());
    assertEquals(saved, {
      ...snapshot,
      currentIndex: 2,
      positionMs: 12345678901,
      updatedAtMs: saved.updatedAtMs,
    });
    await t.domain.saveState(1, {
      state: 'stop',
      currentIndex: null,
      positionMs: 0,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    assertEquals(
      await t.all(
        'SELECT player_id AS id, state, current_index, position_ms, repeat, shuffle, consume FROM player_state',
      ),
      [{
        id: 1,
        state: 'stop',
        current_index: null,
        position_ms: 0,
        repeat: 'off',
        shuffle: false,
        consume: false,
      }],
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.playback.loadPlayerState handles absent and nullable legacy fields as plain data', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    assertEquals(await t.domain.loadPlayerState(1), null);
    await t.run(
      "INSERT INTO player_state (player_id, state) VALUES (1, 'pause')",
    );
    assertEquals(await t.domain.loadPlayerState(1), {
      state: 'pause',
      currentIndex: null,
      positionMs: 0,
      repeat: 'off',
      shuffle: false,
      consume: false,
      updatedAtMs: 0,
    });
  } finally {
    await t.close();
  }
});

Deno.test('store.playback.saveOutput upserts every remote field and clears absent optional identity', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    await t.domain.saveOutput({
      id: "remote'",
      name: "Name'",
      type: "AirPlay'",
      host: "host'",
      port: 7000.9,
      selected: true,
      volume: 42.9,
      model: "Model'",
      connectionStrategy: 'owntone',
    });
    assertEquals(await t.domain.loadOutputs(), [{
      id: "remote'",
      name: "Name'",
      type: "AirPlay'",
      host: "host'",
      port: 7000,
      selected: true,
      volume: 42,
      model: "Model'",
      connectionStrategy: 'owntone',
    }]);
    const replacement = {
      id: "remote'",
      name: 'New',
      type: 'Other',
      selected: false,
      volume: 9,
      connectionStrategy: 'audiostation',
    };
    await t.domain.saveOutput(replacement);
    assertEquals(await t.domain.loadOutputs(), [replacement]);
    assertEquals(
      await t.all(
        'SELECT host, port, model FROM output_state',
      ),
      [{ host: null, port: null, model: null }],
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.playback.loadOutputs converts null identity and returns strategy data for service validation', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    assertEquals(await t.domain.loadOutputs(), []);
    await t.run(
      `INSERT INTO output_state (id, player_id, volume, connection_strategy)
       VALUES ('legacy', NULL, 100, NULL), ('corrupt', 1, 7, 'corrupt')`,
    );
    assertEquals(
      (await t.domain.loadOutputs()).sort((a, b) => a.id.localeCompare(b.id)),
      [{
        id: 'corrupt',
        name: '',
        type: '',
        selected: true,
        volume: 7,
        connectionStrategy: 'corrupt',
      }, {
        id: 'legacy',
        name: '',
        type: '',
        selected: false,
        volume: 100,
      }],
    );
  } finally {
    await t.close();
  }
});

Deno.test('store.playback.saveQueue restores the previous queue after real input violates a constraint', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    // Test-only referential constraint triggers a real DuckDB INSERT failure
    // after DELETE. Production queues still permit missing catalog ids.
    await t.run('DROP TABLE server_queue');
    await t.run(`CREATE TABLE server_queue (
      player_id INTEGER NOT NULL,
      pos INTEGER NOT NULL,
      entry_id BIGINT UNIQUE NOT NULL,
      reference_kind VARCHAR NOT NULL,
      reference_value VARCHAR NOT NULL REFERENCES files(id),
      PRIMARY KEY (player_id, pos)
    )`);
    await t.domain.saveQueue(1, songQueue(['song', 'song']));
    await assertRejects(
      () => t.domain.saveQueue(1, songQueue(['song', 'missing'])),
      Error,
      'Constraint',
    );
    assertEquals(await t.domain.loadQueue(1), songQueue(['song', 'song']));
    await t.domain.saveQueue(1, songQueue(['song']));
    assertEquals(await t.domain.loadQueue(1), {
      ...songQueue(['song']),
      nextId: 3,
    });
  } finally {
    await t.close();
  }
});

Deno.test('store.playback upgrades a song-only queue once, preserving order, duplicates and bookmark across reopens', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'melofon-queue-upgrade-' });
  let store = await openStore(dir);
  try {
    await rawSql(store).run(
      "DELETE FROM migrations WHERE id IN ('server-queue-001', 'players-001')",
    );
    await rawSql(store).run('DROP TABLE server_queue');
    await rawSql(store).run('DROP TABLE server_queue_state');
    await rawSql(store).run('DROP TABLE server_queue_allocator');
    await rawSql(store).run(
      'CREATE TABLE server_queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_id BIGINT NOT NULL, version BIGINT NOT NULL)',
    );
    await rawSql(store).run(
      'CREATE TABLE server_queue (pos INTEGER PRIMARY KEY, song_id VARCHAR NOT NULL)',
    );
    await rawSql(store).run(
      "INSERT INTO server_queue VALUES (2, 'duplicate'), (0, 'duplicate'), (1, 'middle')",
    );
    await store.playback.saveState(1, {
      ...stopped,
      state: 'pause',
      currentIndex: 1,
      positionMs: 4321,
    });
    const saved = await store.playback.loadPlayerState(1);
    await store.close();
    store = await openStore(dir);
    const queue = await store.playback.loadQueue(1);
    assertEquals(queue, songQueue(['duplicate', 'middle', 'duplicate']));
    assertEquals(await store.playback.loadPlayerState(1), saved);
    await store.close();
    store = await openStore(dir);
    assertEquals(
      await store.playback.loadQueue(1),
      queue,
      'ids/allocator unchanged by another upgrade open',
    );
    assertEquals(await store.playback.loadPlayerState(1), saved);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store.playback rolls back queue, allocator, revision and bookmark together on commit failure', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    const original = songQueue(['song']);
    await t.domain.saveQueue(1, original, {
      ...stopped,
      state: 'pause',
      currentIndex: 0,
      positionMs: 55,
    });
    const state = await t.domain.loadPlayerState(1);
    t.failCommit();
    await assertRejects(
      () =>
        t.domain.saveQueue(1, {
          ...songQueue(['other', 'other']),
          nextId: 99,
          version: 8,
        }, stopped),
      Error,
      'injected commit failure',
    );
    assertEquals(await t.domain.loadQueue(1), original);
    assertEquals(await t.domain.loadPlayerState(1), state);
  } finally {
    await t.close();
  }
});
