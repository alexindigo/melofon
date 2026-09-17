// src/clientqueue.ts — app.clientQueue: the Subsonic play queue, one row per
// user (upsert on user_id). This is the client's saved playback state, not a
// server-side player — the server-side outputs queue is M5/M6.
import type { Db } from './db.ts';
import { userIdForName } from './user.ts';

export interface PlayQueueRow {
  trackIds: string[];
  currentId: string | null;
  positionMs: number | null;
  changedAtMs: number;
  /** Name of the client that saved the queue (null on pre-M4.5 rows). */
  changedBy: string | null;
}

export interface ClientQueue {
  get(username: string): Promise<PlayQueueRow | null>;
  save(
    username: string,
    queue: {
      trackIds: string[];
      currentId?: string;
      positionMs?: number;
      changedBy?: string;
    },
  ): Promise<void>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createClientQueue(db: Db): ClientQueue {
  return {
    async get(username) {
      const userId = await userIdForName(db, username);
      if (userId === null) throw new Error(`unknown user: ${username}`);
      const res = await db.conn.runAndReadAll(
        `SELECT current_id, position_ms,
                epoch_ms(changed_at)::BIGINT AS changed_ms, track_ids,
                changed_by
         FROM play_queues WHERE user_id = ${esc(userId)}`,
      );
      const row = (res.getRowObjects() as {
        current_id: string | null;
        position_ms: number | bigint | null;
        changed_ms: bigint | number;
        track_ids: { items: string[] };
        changed_by: string | null;
      }[])[0];
      if (!row) return null;
      return {
        trackIds: row.track_ids.items,
        currentId: row.current_id,
        positionMs: row.position_ms === null ? null : Number(row.position_ms),
        changedAtMs: Number(row.changed_ms),
        changedBy: row.changed_by,
      };
    },

    async save(username, queue) {
      const userId = await userIdForName(db, username);
      if (userId === null) throw new Error(`unknown user: ${username}`);
      const current = queue.currentId === undefined
        ? 'NULL'
        : esc(queue.currentId);
      const position = queue.positionMs === undefined
        ? 'NULL'
        : String(Math.trunc(queue.positionMs));
      const changedBy = queue.changedBy === undefined
        ? 'NULL'
        : esc(queue.changedBy);
      const trackIds = `[${queue.trackIds.map(esc).join(', ')}]`;
      await db.conn.run(
        `INSERT INTO play_queues
           (user_id, current_id, position_ms, changed_at, track_ids,
            changed_by)
         VALUES (${esc(userId)}, ${current}, ${position}, now(), ${trackIds},
                 ${changedBy})
         ON CONFLICT (user_id) DO UPDATE SET
           current_id = excluded.current_id,
           position_ms = excluded.position_ms,
           changed_at = excluded.changed_at,
           track_ids = excluded.track_ids,
           changed_by = excluded.changed_by`,
      );
    },
  };
}
