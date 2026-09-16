// src/annotation.ts — app.annotation: per-user stars and ratings. The hat
// passes its state username; core resolves the internal user_id (users.id)
// so state tables never expose it to the layer. Keep-on-rescan: nothing here
// touches the catalog tables and the scan never touches these.
import type { Db } from './db.ts';
import { userIdForName } from './user.ts';

export interface StarredRow {
  targetId: string;
  targetType: string; // 'song' | 'album' | 'artist'
  starredAtMs: number; // epoch milliseconds
}

export interface Annotation {
  /** Idempotent: re-starring keeps the original starred_at. */
  star(username: string, targetId: string, targetType: string): Promise<void>;
  unstar(
    username: string,
    targetId: string,
    targetType: string,
  ): Promise<void>;
  /** Subsonic 1..5; 0 clears the rating row. */
  setRating(
    username: string,
    targetId: string,
    rating: number,
  ): Promise<void>;
  /** Everything the user has starred, newest first. */
  starred(username: string): Promise<StarredRow[]>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createAnnotation(db: Db): Annotation {
  async function userId(username: string): Promise<string> {
    const id = await userIdForName(db, username);
    if (id === null) throw new Error(`unknown user: ${username}`);
    return id;
  }

  return {
    async star(username, targetId, targetType) {
      const userId_ = await userId(username);
      await db.conn.run(
        `INSERT INTO stars (user_id, target_id, target_type, starred_at)
         VALUES (${esc(userId_)}, ${esc(targetId)}, ${esc(targetType)}, now())
         ON CONFLICT DO NOTHING`,
      );
    },

    async unstar(username, targetId, targetType) {
      const userId_ = await userId(username);
      await db.conn.run(
        `DELETE FROM stars
         WHERE user_id = ${esc(userId_)} AND target_id = ${esc(targetId)}
           AND target_type = ${esc(targetType)}`,
      );
    },

    async setRating(username, targetId, rating) {
      const userId_ = await userId(username);
      if (rating === 0) {
        await db.conn.run(
          `DELETE FROM ratings
           WHERE user_id = ${esc(userId_)} AND target_id = ${esc(targetId)}`,
        );
        return;
      }
      await db.conn.run(
        `INSERT INTO ratings (user_id, target_id, rating)
         VALUES (${esc(userId_)}, ${esc(targetId)}, ${rating})
         ON CONFLICT (user_id, target_id) DO UPDATE SET
           rating = excluded.rating`,
      );
    },

    async starred(username) {
      const userId_ = await userId(username);
      const res = await db.conn.runAndReadAll(
        `SELECT target_id, target_type,
                epoch_ms(starred_at)::BIGINT AS starred_ms
         FROM stars WHERE user_id = ${esc(userId_)}
         ORDER BY starred_at DESC`,
      );
      return (res.getRowObjects() as {
        target_id: string;
        target_type: string;
        starred_ms: bigint | number;
      }[]).map((row) => ({
        targetId: row.target_id,
        targetType: row.target_type,
        starredAtMs: Number(row.starred_ms),
      }));
    },
  };
}
