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
}

export interface ClientQueue {
  get(username: string): Promise<PlayQueueRow | null>;
  save(
    username: string,
    queue: {
      trackIds: string[];
      currentId?: string;
      positionMs?: number;
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
                epoch_ms(changed_at)::BIGINT AS changed_ms, track_ids
         FROM play_queues WHERE user_id = ${esc(userId)}`,
      );
      const row = (res.getRowObjects() as {
        current_id: string | null;
        position_ms: number | bigint | null;
        changed_ms: bigint | number;
        track_ids: { items: string[] };
      }[])[0];
      if (!row) return null;
      return {
        trackIds: row.track_ids.items,
        currentId: row.current_id,
        positionMs: row.position_ms === null ? null : Number(row.position_ms),
        changedAtMs: Number(row.changed_ms),
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
      const trackIds = `[${queue.trackIds.map(esc).join(', ')}]`;
      await db.conn.run(
        `INSERT INTO play_queues
           (user_id, current_id, position_ms, changed_at, track_ids)
         VALUES (${esc(userId)}, ${current}, ${position}, now(), ${trackIds})
         ON CONFLICT (user_id) DO UPDATE SET
           current_id = excluded.current_id,
           position_ms = excluded.position_ms,
           changed_at = excluded.changed_at,
           track_ids = excluded.track_ids`,
      );
    },
  };
}
