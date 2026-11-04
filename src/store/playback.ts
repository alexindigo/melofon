import { type Engine, esc, type Queries } from './engine.ts';
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
  await q.run(`INSERT INTO server_queue_state
    SELECT 1, coalesce(max(entry_id), 0) + 1, CASE WHEN count(*) > 0 THEN 1 ELSE 0 END
    FROM server_queue ON CONFLICT DO NOTHING`);
}

async function saveState(q: Queries, snapshot: PlayerSnapshot): Promise<void> {
  await q.run(
    `INSERT INTO player_state (id, state, current_index, position_ms,
       repeat, shuffle, consume, updated_at)
     VALUES (1, ${esc(snapshot.state)},
       ${
      snapshot.currentIndex === null
        ? 'NULL'
        : Math.trunc(snapshot.currentIndex)
    },
       ${Math.trunc(snapshot.positionMs)}, ${esc(snapshot.repeat)},
       ${snapshot.shuffle}, ${snapshot.consume}, now())
     ON CONFLICT (id) DO UPDATE SET
       state = excluded.state, current_index = excluded.current_index,
       position_ms = excluded.position_ms, repeat = excluded.repeat,
       shuffle = excluded.shuffle, consume = excluded.consume,
       updated_at = excluded.updated_at`,
  );
}

export function createPlaybackStore(
  engine: Engine,
  speakers = createSpeakersStore(engine),
) {
  return {
    saveQueue(snapshot: QueueSnapshot, state?: PlayerSnapshot): Promise<void> {
      if (
        !Number.isSafeInteger(snapshot.nextId) || snapshot.nextId < 1 ||
        !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 ||
        snapshot.items.some((e) =>
          !Number.isSafeInteger(e.id) || e.id < 1 || e.id >= snapshot.nextId
        )
      ) {
        return Promise.reject(new Error('Invalid queue identity snapshot'));
      }
      return engine.exclusive(async (q) => {
        // DELETE+INSERT in one transaction: a SIGKILL between them must not
        // persist an empty queue over a full one.
        await q.run('BEGIN TRANSACTION');
        try {
          await q.run('DELETE FROM server_queue');
          if (snapshot.items.length > 0) {
            const values = snapshot.items
              .map(({ id, reference }, pos) =>
                `(${pos}, ${id}, ${esc(reference.kind)}, ${
                  esc(reference.kind === 'url' ? reference.url : reference.id)
                })`
              )
              .join(', ');
            await q.run(
              `INSERT INTO server_queue (pos, entry_id, reference_kind, reference_value) VALUES ${values}`,
            );
          }
          await q.run(
            `UPDATE server_queue_state SET next_id = ${snapshot.nextId},
            version = ${snapshot.version} WHERE id = 1`,
          );
          if (state) await saveState(q, state);
          await q.run('COMMIT');
        } catch (err) {
          await q.run('ROLLBACK').catch(() => {});
          throw err;
        }
      });
    },

    saveState(snapshot: PlayerSnapshot): Promise<void> {
      return engine.exclusive((q) => saveState(q, snapshot));
    },

    loadQueue(): Promise<QueueSnapshot> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<
          {
            entry_id: number;
            reference_kind: QueueReference['kind'];
            reference_value: string;
          }
        >(
          'SELECT entry_id, reference_kind, reference_value FROM server_queue ORDER BY pos',
        );
        const [state] = await q.all<{ next_id: number; version: number }>(
          'SELECT next_id, version FROM server_queue_state WHERE id = 1',
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

    loadPlayerState(): Promise<PersistedPlayerState | null> {
      return engine.exclusive(async (q) => {
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
         FROM player_state WHERE id = 1`,
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
