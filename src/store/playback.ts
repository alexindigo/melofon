import { type Engine, esc } from './engine.ts';

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

/** Storage data only; the persistence service validates transport policy. */
export interface OutputSnapshot {
  id: string;
  host?: string;
  port?: number;
  name: string;
  type: string;
  selected: boolean;
  volume: number;
  model?: string;
  connectionStrategy?: string;
}

export function createPlaybackStore(engine: Engine) {
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

    saveOutput(
      row: OutputSnapshot & { connectionStrategy: string },
    ): Promise<void> {
      return engine.exclusive(async (q) => {
        await q.run(
          `INSERT INTO output_state (id, host, port, name, type, selected,
             volume, model, connection_strategy)
           VALUES (${esc(row.id)},
             ${row.host === undefined ? 'NULL' : esc(row.host)},
             ${row.port === undefined ? 'NULL' : Math.trunc(row.port)},
             ${esc(row.name)}, ${esc(row.type)},
             ${row.selected}, ${Math.trunc(row.volume)},
             ${row.model === undefined ? 'NULL' : esc(row.model)}, ${
            esc(row.connectionStrategy)
          })
           ON CONFLICT (id) DO UPDATE SET
             host = excluded.host,
             port = excluded.port,
             name = excluded.name,
             type = excluded.type,
             selected = excluded.selected,
             volume = excluded.volume,
             model = excluded.model,
             connection_strategy = excluded.connection_strategy`,
        );
      });
    },

    loadOutputs(): Promise<OutputSnapshot[]> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{
          id: string;
          host: string | null;
          port: number | null;
          name: string | null;
          type: string | null;
          selected: boolean;
          volume: number;
          model: string | null;
          connection_strategy: string | null;
        }>(
          'SELECT id, host, port, name, type, selected, volume, model, connection_strategy FROM output_state',
        );
        return rows.map((row) => ({
          id: row.id,
          ...(row.host === null ? {} : { host: row.host }),
          ...(row.port === null ? {} : { port: Number(row.port) }),
          name: row.name ?? '',
          type: row.type ?? '',
          selected: row.selected,
          volume: Number(row.volume),
          ...(row.model === null ? {} : { model: row.model }),
          ...(row.connection_strategy === null
            ? {}
            : { connectionStrategy: row.connection_strategy }),
        }));
      });
    },
  };
}
