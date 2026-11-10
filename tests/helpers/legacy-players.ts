import type { Store } from '../../src/store/index.ts';
import { rawSql } from '../../src/store/testing.ts';

/** Released singleton storage, rebuilt through the sole raw fixture seam. */
export async function legacyPlayerStorage(
  store: Store,
  prePart1 = false,
  empty = false,
) {
  const q = rawSql(store);
  await q.run("DELETE FROM migrations WHERE id = 'players-001'");
  if (prePart1) {
    await q.run(
      "DELETE FROM migrations WHERE id IN ('server-queue-001', 'speakers-001')",
    );
  }
  for (
    const table of [
      'players',
      'server_queue',
      'server_queue_state',
      'server_queue_allocator',
      'player_state',
    ]
  ) {
    await q.run(`DROP TABLE ${table}`);
  }
  if (!prePart1) {
    await q.run(
      'CREATE TABLE server_queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_id BIGINT NOT NULL, version BIGINT NOT NULL)',
    );
  }
  await q.run(
    `CREATE TABLE server_queue (${
      prePart1
        ? 'pos INTEGER PRIMARY KEY, song_id VARCHAR NOT NULL'
        : 'pos INTEGER PRIMARY KEY, entry_id BIGINT UNIQUE NOT NULL, reference_kind VARCHAR NOT NULL, reference_value VARCHAR NOT NULL'
    })`,
  );
  if (!empty) {
    await q.run(
      prePart1
        ? "INSERT INTO server_queue VALUES (2, 'dup'), (0, 'dup'), (1, 'middle')"
        : "INSERT INTO server_queue VALUES (2, 12, 'url', 'http://melofon.home/live?x=1#keep'), (0, 4, 'song', 'dup'), (1, 9, 'station', 'station-1')",
    );
  }
  if (!prePart1) {
    await q.run('INSERT INTO server_queue_state VALUES (1, 81, 29)');
  }
  await q.run(
    `CREATE TABLE player_state (id INTEGER PRIMARY KEY CHECK (id = 1), state VARCHAR NOT NULL,
    current_index INTEGER, position_ms BIGINT, repeat VARCHAR, shuffle BOOLEAN, consume BOOLEAN, updated_at TIMESTAMPTZ)`,
  );
  await q.run(
    "INSERT INTO player_state VALUES (1, 'play', 1, 4321, 'single', true, true, TIMESTAMPTZ '2020-01-02 03:04:05.678+00')",
  );
  await q.run(
    'ALTER TABLE output_state ADD COLUMN selected BOOLEAN DEFAULT false',
  );
  await q.run(
    'UPDATE output_state SET selected = coalesce(player_id = 1, false)',
  );
  await q.run('ALTER TABLE output_state ALTER COLUMN selected SET NOT NULL');
  await q.run('ALTER TABLE output_state DROP COLUMN player_id');
  await q.run('ALTER TABLE output_state DROP COLUMN linked');
  if (prePart1) await q.run('ALTER TABLE output_state DROP COLUMN adopted');
}
