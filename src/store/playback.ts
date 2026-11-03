import { type Engine, esc } from './engine.ts';
import { createSpeakersStore } from './speakers.ts';

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

export function createPlaybackStore(
  engine: Engine,
  speakers = createSpeakersStore(engine),
) {
  return {
    saveQueue(songIds: string[]): Promise<void> {
      return engine.exclusive(async (q) => {
        // DELETE+INSERT in one transaction: a SIGKILL between them must not
        // persist an empty queue over a full one.
        await q.run('BEGIN TRANSACTION');
        try {
          await q.run('DELETE FROM server_queue');
          if (songIds.length > 0) {
            const values = songIds
              .map((id, pos) => `(${pos}, ${esc(id)})`)
              .join(', ');
            await q.run(
              `INSERT INTO server_queue (pos, song_id) VALUES ${values}`,
            );
          }
          await q.run('COMMIT');
        } catch (err) {
          await q.run('ROLLBACK').catch(() => {});
          throw err;
        }
      });
    },

    saveState(snapshot: PlayerSnapshot): Promise<void> {
      return engine.exclusive(async (q) => {
        await q.run(
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

    loadQueue(): Promise<string[]> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{ song_id: string }>(
          'SELECT song_id FROM server_queue ORDER BY pos',
        );
        return rows.map((r) => r.song_id);
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
