// src/nowplaying.ts — app.nowPlaying: the current play per (user, client),
// Navidrome's player-keyed NowPlaying. scrobble submission=false replaces the
// row; submission=true never touches it (that path is append-only listens);
// stream never writes here. Keep-on-rescan user state. Hats pass the state
// username; core keys rows by internal user_id.
import type { Db } from './db.ts';
import { userIdForName } from './user.ts';

export interface NowPlayingRow {
  username: string;
  client: string;
  trackId: string;
  positionMs: number | null;
  startedAtMs: number;
}

export interface NowPlaying {
  /** Replace the (user, client) row — a new play supersedes the old one. */
  set(
    username: string,
    client: string,
    trackId: string,
    positionMs?: number,
  ): Promise<void>;
  /** All users' current plays, newest first (getNowPlaying is server-wide). */
  list(): Promise<NowPlayingRow[]>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createNowPlaying(db: Db): NowPlaying {
  return {
    async set(username, client, trackId, positionMs) {
      const userId = await userIdForName(db, username);
      if (userId === null) throw new Error(`unknown user: ${username}`);
      await db.conn.run(
        `INSERT INTO now_playing (user_id, client, track_id, position_ms,
           started_at)
         VALUES (${esc(userId)}, ${esc(client)}, ${esc(trackId)},
           ${positionMs === undefined ? 'NULL' : Math.trunc(positionMs)},
           now())
         ON CONFLICT (user_id, client) DO UPDATE SET
           track_id = excluded.track_id,
           position_ms = excluded.position_ms,
           started_at = excluded.started_at`,
      );
    },

    async list() {
      const res = await db.conn.runAndReadAll(
        `SELECT u.name AS username, n.client, n.track_id, n.position_ms,
                epoch_ms(n.started_at)::BIGINT AS started_ms
         FROM now_playing n
         JOIN users u ON u.id = n.user_id
         ORDER BY n.started_at DESC`,
      );
      return (res.getRowObjects() as {
        username: string;
        client: string;
        track_id: string;
        position_ms: number | bigint | null;
        started_ms: number | bigint;
      }[]).map((row) => ({
        username: row.username,
        client: row.client,
        trackId: row.track_id,
        positionMs: row.position_ms === null ? null : Number(row.position_ms),
        startedAtMs: Number(row.started_ms),
      }));
    },
  };
}
