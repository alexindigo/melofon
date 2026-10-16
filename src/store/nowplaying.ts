import { atomic, type Engine, esc } from './engine.ts';
import { requireUserId } from './users.ts';

export interface NowPlayingRow {
  username: string;
  client: string;
  trackId: string;
  streamId: string | null;
  positionMs: number | null;
  startedAtMs: number;
}

export function createNowPlayingStore(engine: Engine) {
  return {
    set(
      username: string,
      client: string,
      trackId: string,
      streamId: string,
      positionMs?: number,
    ): Promise<void> {
      return atomic(engine, async (q) => {
        const userId = await requireUserId(q, username);
        await q.run(
          `INSERT INTO now_playing (user_id, client, track_id, stream_id,
           position_ms, started_at)
         VALUES (${esc(userId)}, ${esc(client)}, ${esc(trackId)},
           ${esc(streamId)},
           ${positionMs === undefined ? 'NULL' : Math.trunc(positionMs)},
           now())
         ON CONFLICT (user_id, client) DO UPDATE SET
            track_id = excluded.track_id,
            stream_id = excluded.stream_id,
            position_ms = excluded.position_ms,
            started_at = excluded.started_at`,
        );
      });
    },
    clearByStreamId(streamId: string): Promise<boolean> {
      return atomic(engine, async (q) => {
        const existing = await q.all(
          `SELECT 1 AS x FROM now_playing WHERE stream_id = ${esc(streamId)}`,
        );
        if (existing.length === 0) return false;
        await q.run(
          `DELETE FROM now_playing WHERE stream_id = ${esc(streamId)}`,
        );
        return true;
      });
    },
    list(): Promise<NowPlayingRow[]> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{
          username: string;
          client: string;
          track_id: string;
          stream_id: string | null;
          position_ms: number | null;
          started_ms: number;
        }>(`SELECT u.name AS username, n.client, n.track_id, n.stream_id,
                n.position_ms,
                epoch_ms(n.started_at)::BIGINT AS started_ms
         FROM now_playing n
         JOIN users u ON u.id = n.user_id
         ORDER BY n.started_at DESC`);
        return rows.map((row) => ({
          username: row.username,
          client: row.client,
          trackId: row.track_id,
          streamId: row.stream_id,
          positionMs: row.position_ms === null ? null : Number(row.position_ms),
          startedAtMs: Number(row.started_ms),
        }));
      });
    },
  };
}
