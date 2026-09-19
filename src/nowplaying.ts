// src/nowplaying.ts — app.nowPlaying: the client-session table (plane B) —
// the current play per (user, client), Navidrome's player-keyed NowPlaying.
// Written ONLY via app.playback commands (reportPlaying / reportStopped);
// hats never touch this store. Keep-on-rescan user state. Core keys rows by
// internal user_id.
import type { Db } from './db.ts';
import { userIdForName } from './user.ts';

export interface NowPlayingRow {
  username: string;
  client: string;
  trackId: string;
  /** The stream/report that minted this row (null on pre-playback-core
   * rows — a reportStopped for them never matches, so they age out by
   * supersede, not by stop). */
  streamId: string | null;
  positionMs: number | null;
  startedAtMs: number;
}

export interface NowPlaying {
  /** Replace the (user, client) row — a new play supersedes the old one. */
  set(
    username: string,
    client: string,
    trackId: string,
    streamId: string,
    positionMs?: number,
  ): Promise<void>;
  /** Clear the row whose streamId is still current. True when a row went. */
  clearByStreamId(streamId: string): Promise<boolean>;
  /** All users' current plays, newest first (getNowPlaying is server-wide). */
  list(): Promise<NowPlayingRow[]>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createNowPlaying(db: Db): NowPlaying {
  return {
    async set(username, client, trackId, streamId, positionMs) {
      const userId = await userIdForName(db, username);
      if (userId === null) throw new Error(`unknown user: ${username}`);
      await db.conn.run(
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
    },

    async clearByStreamId(streamId) {
      const existing = await db.conn.runAndReadAll(
        `SELECT 1 AS x FROM now_playing WHERE stream_id = ${esc(streamId)}`,
      );
      if (existing.getRowObjects().length === 0) return false;
      await db.conn.run(
        `DELETE FROM now_playing WHERE stream_id = ${esc(streamId)}`,
      );
      return true;
    },

    async list() {
      const res = await db.conn.runAndReadAll(
        `SELECT u.name AS username, n.client, n.track_id, n.stream_id,
                n.position_ms,
                epoch_ms(n.started_at)::BIGINT AS started_ms
         FROM now_playing n
         JOIN users u ON u.id = n.user_id
         ORDER BY n.started_at DESC`,
      );
      return (res.getRowObjects() as {
        username: string;
        client: string;
        track_id: string;
        stream_id: string | null;
        position_ms: number | bigint | null;
        started_ms: number | bigint;
      }[]).map((row) => ({
        username: row.username,
        client: row.client,
        trackId: row.track_id,
        streamId: row.stream_id,
        positionMs: row.position_ms === null ? null : Number(row.position_ms),
        startedAtMs: Number(row.started_ms),
      }));
    },
  };
}
