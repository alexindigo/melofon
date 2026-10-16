import { atomic, type Engine, esc } from './engine.ts';
import { requireUserId } from './users.ts';

export interface PlayQueueRow {
  trackIds: string[];
  currentId: string | null;
  positionMs: number | null;
  changedAtMs: number;
  changedBy: string | null;
}

export function createClientQueueStore(engine: Engine) {
  return {
    get(username: string): Promise<PlayQueueRow | null> {
      return atomic(engine, async (q) => {
        const userId = await requireUserId(q, username);
        const rows = await q.all<{
          current_id: string | null;
          position_ms: number | null;
          changed_ms: number;
          track_ids: string[];
          changed_by: string | null;
        }>(`SELECT current_id, position_ms,
                epoch_ms(changed_at)::BIGINT AS changed_ms, track_ids,
                changed_by
         FROM play_queues WHERE user_id = ${esc(userId)}`);
        const row = rows[0];
        if (!row) return null;
        return {
          trackIds: row.track_ids,
          currentId: row.current_id,
          positionMs: row.position_ms === null ? null : Number(row.position_ms),
          changedAtMs: Number(row.changed_ms),
          changedBy: row.changed_by,
        };
      });
    },
    save(
      username: string,
      queue: {
        trackIds: string[];
        currentId?: string;
        positionMs?: number;
        changedBy?: string;
      },
    ): Promise<void> {
      return atomic(engine, async (q) => {
        const userId = await requireUserId(q, username);
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
        await q.run(`INSERT INTO play_queues
           (user_id, current_id, position_ms, changed_at, track_ids,
            changed_by)
         VALUES (${esc(userId)}, ${current}, ${position}, now(), ${trackIds},
                 ${changedBy})
         ON CONFLICT (user_id) DO UPDATE SET
           current_id = excluded.current_id,
           position_ms = excluded.position_ms,
           changed_at = excluded.changed_at,
           track_ids = excluded.track_ids,
           changed_by = excluded.changed_by`);
      });
    },
  };
}
