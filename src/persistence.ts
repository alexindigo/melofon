// src/persistence.ts — the DuckDB adapter for the player and outputs
// persistence ports (server_queue / player_state / output_state — plan
// restart-transparency). The engine is synchronous, so saves are
// fire-and-forget, serialized on one tail so a fast run of commands can't
// interleave a DELETE/INSERT pair with the next mutation's (the spike
// measured p99 ~12 ms on the one connection — cheap). Loads are awaited
// once at boot. drain() lets tests await the tail before closing and
// reopening the db.
import type { Db } from './db.ts';
import type {
  OutputPersistence,
  PersistedOutput,
  PlayerPersistence,
  PlayerState,
  PlayerStateSnapshot,
  RepeatMode,
} from './player.ts';

/** The persisted engine snapshot plus the resume-freshness reference. */
export interface PersistedPlayerState extends PlayerStateSnapshot {
  /** Wall-clock ms of the last write (player_state.updated_at). */
  updatedAtMs: number;
}

export interface Persistence extends PlayerPersistence, OutputPersistence {
  /** The persisted queue, pos-ordered library song ids. */
  loadQueue(): Promise<string[]>;
  /** The singleton state row, or null when never persisted. */
  loadPlayerState(): Promise<PersistedPlayerState | null>;
  /** Every persisted output remote (also seeds the savedOutput cache). */
  loadOutputs(): Promise<PersistedOutput[]>;
  /** The last-known persisted row per output id — kept current by
   * saveOutput, so discovery can apply saved user state synchronously. */
  savedOutput(id: string): PersistedOutput | undefined;
  /** Await every queued write (tests: before closing/reopening the db). */
  drain(): Promise<void>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createPersistence(db: Db): Persistence {
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (write: () => Promise<void>): void => {
    tail = tail.then(write).catch((err) => {
      console.debug('[melofon] persistence write failed:', err);
    });
  };
  const outputCache = new Map<string, PersistedOutput>();

  return {
    saveQueue(songIds) {
      enqueue(async () => {
        // DELETE+INSERT in one transaction: a SIGKILL between them must not
        // persist an empty queue over a full one.
        await db.conn.run('BEGIN TRANSACTION');
        try {
          await db.conn.run('DELETE FROM server_queue');
          if (songIds.length > 0) {
            const values = songIds
              .map((id, pos) => `(${pos}, ${esc(id)})`)
              .join(', ');
            await db.conn.run(
              `INSERT INTO server_queue (pos, song_id) VALUES ${values}`,
            );
          }
          await db.conn.run('COMMIT');
        } catch (err) {
          await db.conn.run('ROLLBACK').catch(() => {});
          throw err;
        }
      });
    },

    saveState(snapshot) {
      enqueue(async () => {
        await db.conn.run(
          `INSERT INTO player_state (id, state, current_index, position_ms,
             repeat, shuffle, consume, updated_at)
           VALUES (1, ${esc(snapshot.state)},
             ${
            snapshot.currentIndex === null
              ? 'NULL'
              : Math.trunc(snapshot.currentIndex)
          },
             ${Math.trunc(snapshot.positionMs)},
             ${esc(snapshot.repeat)}, ${snapshot.shuffle}, ${snapshot.consume},
             now())
           ON CONFLICT (id) DO UPDATE SET
             state = excluded.state,
             current_index = excluded.current_index,
             position_ms = excluded.position_ms,
             repeat = excluded.repeat,
             shuffle = excluded.shuffle,
             consume = excluded.consume,
             updated_at = excluded.updated_at`,
        );
      });
    },

    async loadQueue() {
      const res = await db.conn.runAndReadAll(
        'SELECT song_id FROM server_queue ORDER BY pos',
      );
      return (res.getRowObjects() as { song_id: string }[]).map((r) =>
        r.song_id
      );
    },

    async loadPlayerState() {
      const res = await db.conn.runAndReadAll(
        `SELECT state, current_index, position_ms, repeat, shuffle, consume,
                epoch_ms(updated_at)::BIGINT AS updated_ms
         FROM player_state WHERE id = 1`,
      );
      const row = (res.getRowObjects() as {
        state: string;
        current_index: number | null;
        position_ms: number | bigint | null;
        repeat: string | null;
        shuffle: boolean | null;
        consume: boolean | null;
        updated_ms: number | bigint | null;
      }[])[0];
      if (row === undefined) return null;
      return {
        state: row.state as PlayerState,
        currentIndex: row.current_index,
        positionMs: row.position_ms === null ? 0 : Number(row.position_ms),
        repeat: (row.repeat ?? 'off') as RepeatMode,
        shuffle: row.shuffle ?? false,
        consume: row.consume ?? false,
        updatedAtMs: Number(row.updated_ms ?? 0),
      };
    },

    saveOutput(row) {
      outputCache.set(row.id, row);
      enqueue(async () => {
        await db.conn.run(
          `INSERT INTO output_state (id, host, port, name, type, selected,
             volume)
           VALUES (${esc(row.id)},
             ${row.host === undefined ? 'NULL' : esc(row.host)},
             ${row.port === undefined ? 'NULL' : Math.trunc(row.port)},
             ${esc(row.name)}, ${esc(row.type)},
             ${row.selected}, ${Math.trunc(row.volume)})
           ON CONFLICT (id) DO UPDATE SET
             host = excluded.host,
             port = excluded.port,
             name = excluded.name,
             type = excluded.type,
             selected = excluded.selected,
             volume = excluded.volume`,
        );
      });
    },

    async loadOutputs() {
      const res = await db.conn.runAndReadAll(
        'SELECT id, host, port, name, type, selected, volume FROM output_state',
      );
      const rows = (res.getRowObjects() as {
        id: string;
        host: string | null;
        port: number | null;
        name: string | null;
        type: string | null;
        selected: boolean;
        volume: number;
      }[]).map((row) => ({
        id: row.id,
        ...(row.host === null ? {} : { host: row.host }),
        ...(row.port === null ? {} : { port: Number(row.port) }),
        name: row.name ?? '',
        type: row.type ?? '',
        selected: row.selected,
        volume: Number(row.volume),
      }));
      for (const row of rows) outputCache.set(row.id, row);
      return rows;
    },

    savedOutput: (id) => outputCache.get(id),

    drain: () => tail,
  };
}
