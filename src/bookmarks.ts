// src/bookmarks.ts — app.bookmarks: per-user playback-position bookmarks
// (Subsonic getBookmarks / createBookmark / deleteBookmark). Keep-on-rescan
// user state, like stars: the scan never touches this table.
import type { Db } from './db.ts';
import { userIdForName } from './user.ts';

export interface BookmarkRow {
  trackId: string;
  positionMs: number;
  comment: string | null;
  createdAtMs: number;
  changedAtMs: number;
}

export interface Bookmarks {
  /** Newest-changed first. */
  list(username: string): Promise<BookmarkRow[]>;
  /** Upsert: created_at survives updates, changed_at moves. */
  set(
    username: string,
    trackId: string,
    positionMs: number,
    comment?: string,
  ): Promise<void>;
  remove(username: string, trackId: string): Promise<void>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createBookmarks(db: Db): Bookmarks {
  async function userId(username: string): Promise<string> {
    const id = await userIdForName(db, username);
    if (id === null) throw new Error(`unknown user: ${username}`);
    return id;
  }

  return {
    async list(username) {
      const userId_ = await userId(username);
      const res = await db.conn.runAndReadAll(
        `SELECT track_id, position_ms, comment,
                epoch_ms(created_at)::BIGINT AS created_ms,
                epoch_ms(changed_at)::BIGINT AS changed_ms
         FROM bookmarks
         WHERE user_id = ${esc(userId_)}
         ORDER BY changed_at DESC`,
      );
      return (res.getRowObjects() as {
        track_id: string;
        position_ms: number | bigint;
        comment: string | null;
        created_ms: number | bigint;
        changed_ms: number | bigint;
      }[]).map((row) => ({
        trackId: row.track_id,
        positionMs: Number(row.position_ms),
        comment: row.comment,
        createdAtMs: Number(row.created_ms),
        changedAtMs: Number(row.changed_ms),
      }));
    },

    async set(username, trackId, positionMs, comment) {
      const userId_ = await userId(username);
      await db.conn.run(
        `INSERT INTO bookmarks
           (user_id, track_id, position_ms, comment, created_at, changed_at)
         VALUES (${esc(userId_)}, ${esc(trackId)}, ${Math.trunc(positionMs)},
           ${comment === undefined ? 'NULL' : esc(comment)}, now(), now())
         ON CONFLICT (user_id, track_id) DO UPDATE SET
           position_ms = excluded.position_ms,
           comment = excluded.comment,
           changed_at = excluded.changed_at`,
      );
    },

    async remove(username, trackId) {
      const userId_ = await userId(username);
      await db.conn.run(
        `DELETE FROM bookmarks
         WHERE user_id = ${esc(userId_)} AND track_id = ${esc(trackId)}`,
      );
    },
  };
}
