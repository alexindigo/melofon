import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { createSpeakersStore } from './speakers.ts';
import type { QueueReference, QueueSnapshot } from '../queue-source.ts';

export type { OutputSnapshot } from './speakers.ts';

export interface PlayerSnapshot {
  state: 'play' | 'pause' | 'stop';
  currentIndex: number | null;
  positionMs: number;
  repeat: 'off' | 'all' | 'single';
  shuffle: boolean;
  consume: boolean;
}

/** The persisted engine snapshot plus the resume-freshness reference. */
export interface PersistedPlayerState extends PlayerSnapshot {
  /** Wall-clock ms of the last write (player_state.updated_at). */
  updatedAtMs: number;
}

/** Called inside the release migration transaction, including its ledger row. */
export async function migrateQueueReferences(q: Queries): Promise<void> {
  const keyed = await q.all(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'server_queue' AND column_name = 'player_id'`);
  if (keyed.length) return;
  const legacy = await q.all(`SELECT column_name FROM information_schema.columns
    WHERE table_name = 'server_queue' AND column_name = 'song_id'`);
  if (legacy.length) {
    await q.run(`CREATE TABLE server_queue_typed (
      pos INTEGER PRIMARY KEY, entry_id BIGINT UNIQUE NOT NULL,
      reference_kind VARCHAR NOT NULL CHECK (reference_kind IN ('song', 'station', 'url')),
      reference_value VARCHAR NOT NULL)`);
    await q.run(`INSERT INTO server_queue_typed
      SELECT pos, row_number() OVER (ORDER BY pos), 'song', song_id FROM server_queue`);
    await q.run('DROP TABLE server_queue');
    await q.run('ALTER TABLE server_queue_typed RENAME TO server_queue');
  }
  const keyedState = await q.all(
    `SELECT column_name FROM information_schema.columns
    WHERE table_name = 'server_queue_state' AND column_name = 'player_id'`,
  );
  if (keyedState.length) {
    // Old releases had no revision table. schema.sql has just created its new
    // shape, so compose the old queue conversion directly with that shape.
    await q.run(`INSERT INTO server_queue_state SELECT 1,
      CASE WHEN count(*) > 0 THEN 1 ELSE 0 END FROM server_queue ON CONFLICT DO NOTHING`);
    await q.run(`INSERT INTO server_queue_allocator SELECT 1,
      coalesce(max(entry_id), 0) + 1 FROM server_queue ON CONFLICT DO NOTHING`);
  } else {
    await q.run(`INSERT INTO server_queue_state
      SELECT 1, coalesce(max(entry_id), 0) + 1, CASE WHEN count(*) > 0 THEN 1 ELSE 0 END
      FROM server_queue ON CONFLICT DO NOTHING`);
  }
}

export async function savePlayerState(
  q: Queries,
  playerId: number,
  snapshot: PlayerSnapshot,
): Promise<void> {
  await q.run(
    `INSERT INTO player_state (player_id, state, current_index, position_ms,
       repeat, shuffle, consume, updated_at)
     VALUES (${playerId}, ${esc(snapshot.state)},
       ${
      snapshot.currentIndex === null
        ? 'NULL'
        : Math.trunc(snapshot.currentIndex)
    },
       ${Math.trunc(snapshot.positionMs)}, ${esc(snapshot.repeat)},
       ${snapshot.shuffle}, ${snapshot.consume}, now())
     ON CONFLICT (player_id) DO UPDATE SET
       state = excluded.state, current_index = excluded.current_index,
       position_ms = excluded.position_ms, repeat = excluded.repeat,
       shuffle = excluded.shuffle, consume = excluded.consume,
       updated_at = excluded.updated_at`,
  );
}

/** Internal transaction primitives shared by single- and multi-player saves. */
export async function requirePlayer(
  q: Queries,
  playerId: number,
): Promise<void> {
  if (!Number.isSafeInteger(playerId) || playerId < 1) {
    throw new Error('Invalid player id');
  }
  if (!(await q.all(`SELECT id FROM players WHERE id = ${playerId}`)).length) {
    throw new Error('Player not found');
  }
}

export async function savePlayerQueue(
  q: Queries,
  playerId: number,
  snapshot: QueueSnapshot,
): Promise<void> {
  if (
    !Number.isSafeInteger(snapshot.nextId) || snapshot.nextId < 1 ||
    !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 ||
    snapshot.items.some((e) =>
      !Number.isSafeInteger(e.id) || e.id < 1 || e.id >= snapshot.nextId
    )
  ) {
    throw new Error('Invalid queue identity snapshot');
  }
  await q.run(`DELETE FROM server_queue WHERE player_id = ${playerId}`);
  if (snapshot.items.length) {
    const values = snapshot.items.map(({ id, reference }, pos) =>
      `(${playerId}, ${pos}, ${id}, ${esc(reference.kind)}, ${
        esc(reference.kind === 'url' ? reference.url : reference.id)
      })`
    ).join(', ');
    await q.run(
      `INSERT INTO server_queue (player_id, pos, entry_id, reference_kind, reference_value) VALUES ${values}`,
    );
  }
  await q.run(
    `UPDATE server_queue_allocator SET next_id = greatest(next_id, ${snapshot.nextId}) WHERE id = 1`,
  );
  await q.run(
    `UPDATE server_queue_state SET version = ${snapshot.version} WHERE player_id = ${playerId}`,
  );
}

export async function reservePlayerQueueIds(
  q: Queries,
  count: number,
): Promise<number> {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('Invalid queue id count');
  }
  const [row] = await q.all<{ next_id: number }>(
    'SELECT next_id FROM server_queue_allocator WHERE id = 1',
  );
  const next = Number(row.next_id);
  if (!Number.isSafeInteger(next + count)) {
    throw new Error('Queue id space exhausted');
  }
  await q.run(
    `UPDATE server_queue_allocator SET next_id = ${next + count} WHERE id = 1`,
  );
  return next;
}

export async function deletePlayerPlayback(
  q: Queries,
  playerId: number,
): Promise<void> {
  await q.run(`DELETE FROM server_queue WHERE player_id = ${playerId}`);
  await q.run(`DELETE FROM server_queue_state WHERE player_id = ${playerId}`);
  await q.run(`DELETE FROM player_state WHERE player_id = ${playerId}`);
}

export function createPlaybackStore(
  engine: Engine,
  speakers = createSpeakersStore(engine),
) {
  return {
    saveQueue(
      playerId: number,
      snapshot: QueueSnapshot,
      state?: PlayerSnapshot,
    ): Promise<void> {
      return atomic(engine, async (q) => {
        await requirePlayer(q, playerId);
        await savePlayerQueue(q, playerId, snapshot);
        if (state) await savePlayerState(q, playerId, state);
      });
    },

    saveState(playerId: number, snapshot: PlayerSnapshot): Promise<void> {
      return atomic(engine, async (q) => {
        await requirePlayer(q, playerId);
        await savePlayerState(q, playerId, snapshot);
      });
    },

    loadQueue(playerId: number): Promise<QueueSnapshot> {
      return engine.exclusive(async (q) => {
        await requirePlayer(q, playerId);
        const rows = await q.all<
          {
            entry_id: number;
            reference_kind: QueueReference['kind'];
            reference_value: string;
          }
        >(
          `SELECT entry_id, reference_kind, reference_value FROM server_queue WHERE player_id = ${playerId} ORDER BY pos`,
        );
        const [state] = await q.all<{ next_id: number; version: number }>(
          `SELECT a.next_id, s.version FROM server_queue_allocator a, server_queue_state s WHERE a.id = 1 AND s.player_id = ${playerId}`,
        );
        return {
          items: rows.map((r) => ({
            id: Number(r.entry_id),
            reference: r.reference_kind === 'url'
              ? { kind: 'url', url: r.reference_value }
              : { kind: r.reference_kind, id: r.reference_value },
          })),
          nextId: Number(state.next_id),
          version: Number(state.version),
        };
      });
    },

    loadPlayerState(playerId: number): Promise<PersistedPlayerState | null> {
      return engine.exclusive(async (q) => {
        await requirePlayer(q, playerId);
        const rows = await q.all<{
          state: string;
          current_index: number | null;
          position_ms: number | null;
          repeat: string | null;
          shuffle: boolean | null;
          consume: boolean | null;
          updated_ms: number | null;
        }>(
          `SELECT state, current_index, position_ms, repeat, shuffle, consume,
                epoch_ms(updated_at)::BIGINT AS updated_ms
         FROM player_state WHERE player_id = ${playerId}`,
        );
        const row = rows[0];
        if (row === undefined) return null;
        return {
          state: row.state as PlayerSnapshot['state'],
          currentIndex: row.current_index,
          positionMs: row.position_ms === null ? 0 : Number(row.position_ms),
          repeat: (row.repeat ?? 'off') as PlayerSnapshot['repeat'],
          shuffle: row.shuffle ?? false,
          consume: row.consume ?? false,
          updatedAtMs: Number(row.updated_ms ?? 0),
        };
      });
    },

    saveOutput: speakers.saveOutput,
    loadOutputs: speakers.loadOutputs,
  };
}
