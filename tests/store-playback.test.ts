import { assert, assertEquals, assertRejects } from '@std/assert';
import { createPlaybackStore } from '../src/store/playback.ts';
import { domainFixture } from './helpers/store.ts';

Deno.test('store.playback.saveQueue replaces zero-based positions, preserves duplicates and orphan ids, and clears', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    await t.domain.saveQueue(['old']);
    await t.domain.saveQueue(["missing'", 'song', "missing'"]);
    assertEquals(await t.all('SELECT * FROM server_queue ORDER BY pos'), [
      { pos: 0, song_id: "missing'" },
      { pos: 1, song_id: 'song' },
      { pos: 2, song_id: "missing'" },
    ]);
    await t.domain.saveQueue([]);
    assertEquals(await t.domain.loadQueue(), []);
  } finally {
    await t.close();
  }
});

Deno.test('store.playback.loadQueue returns empty or song ids ordered by position', async () => {
  const t = await domainFixture(createPlaybackStore);
  try {
    assertEquals(await t.domain.loadQueue(), []);
    await t.run(
      "INSERT INTO server_queue VALUES (8, 'last'), (2, 'first'), (5, 'middle')",
    );
    assertEquals(await t.domain.loadQueue(), ['first', 'middle', 'last']);
  } finally {
    await t.close();
  }
});

Deno.test('store.playback.saveState upserts the singleton, truncates positions and records fresh epoch milliseconds', async () => {
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
    await t.domain.saveState(snapshot);
    const saved = (await t.domain.loadPlayerState())!;
    assert(saved.updatedAtMs >= before && saved.updatedAtMs <= Date.now());
    assertEquals(saved, {
      ...snapshot,
      currentIndex: 2,
      positionMs: 12345678901,
      updatedAtMs: saved.updatedAtMs,
    });
    await t.domain.saveState({
      state: 'stop',
      currentIndex: null,
      positionMs: 0,
      repeat: 'off',
      shuffle: false,
      consume: false,
    });
    assertEquals(
      await t.all(
        'SELECT id, state, current_index, position_ms, repeat, shuffle, consume FROM player_state',
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
    assertEquals(await t.domain.loadPlayerState(), null);
    await t.run("INSERT INTO player_state (id, state) VALUES (1, 'pause')");
    assertEquals(await t.domain.loadPlayerState(), {
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
      `INSERT INTO output_state (id, selected, volume, connection_strategy)
       VALUES ('legacy', false, 100, NULL), ('corrupt', true, 7, 'corrupt')`,
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
      pos INTEGER PRIMARY KEY,
      song_id VARCHAR NOT NULL REFERENCES files(id)
    )`);
    await t.domain.saveQueue(['song', 'song']);
    await assertRejects(
      () => t.domain.saveQueue(['song', 'missing']),
      Error,
      'Constraint',
    );
    assertEquals(await t.domain.loadQueue(), ['song', 'song']);
    assertEquals(await t.all('SELECT * FROM server_queue ORDER BY pos'), [
      { pos: 0, song_id: 'song' },
      { pos: 1, song_id: 'song' },
    ]);
    await t.domain.saveQueue(['song']);
    assertEquals(await t.domain.loadQueue(), ['song']);
  } finally {
    await t.close();
  }
});
