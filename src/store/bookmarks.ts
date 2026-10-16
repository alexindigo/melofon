import { atomic, type Engine, esc } from './engine.ts';
import { requireUserId } from './users.ts';

export interface BookmarkRow {
  trackId: string;
  positionMs: number;
  comment: string | null;
  createdAtMs: number;
  changedAtMs: number;
}

export function createBookmarksStore(engine: Engine) {
  return {
    list(username: string): Promise<BookmarkRow[]> {
      return atomic(engine, async (q) => {
        const userId_ = await requireUserId(q, username);
        const rows = await q.all<{
          track_id: string;
          position_ms: number;
          comment: string | null;
          created_ms: number;
          changed_ms: number;
        }>(`SELECT track_id, position_ms, comment,
                epoch_ms(created_at)::BIGINT AS created_ms,
                epoch_ms(changed_at)::BIGINT AS changed_ms
         FROM bookmarks
         WHERE user_id = ${esc(userId_)}
         ORDER BY changed_at DESC`);
        return rows.map((row) => ({
          trackId: row.track_id,
          positionMs: Number(row.position_ms),
          comment: row.comment,
          createdAtMs: Number(row.created_ms),
          changedAtMs: Number(row.changed_ms),
        }));
      });
    },
    set(
      username: string,
      trackId: string,
      positionMs: number,
      comment?: string,
    ): Promise<void> {
      return atomic(engine, async (q) => {
        const userId_ = await requireUserId(q, username);
        await q.run(`INSERT INTO bookmarks
           (user_id, track_id, position_ms, comment, created_at, changed_at)
         VALUES (${esc(userId_)}, ${esc(trackId)}, ${Math.trunc(positionMs)},
           ${comment === undefined ? 'NULL' : esc(comment)}, now(), now())
         ON CONFLICT (user_id, track_id) DO UPDATE SET
           position_ms = excluded.position_ms,
           comment = excluded.comment,
           changed_at = excluded.changed_at`);
      });
    },
    remove(username: string, trackId: string): Promise<void> {
      return atomic(engine, async (q) => {
        const userId_ = await requireUserId(q, username);
        await q.run(`DELETE FROM bookmarks
         WHERE user_id = ${esc(userId_)} AND track_id = ${esc(trackId)}`);
      });
    },
  };
}
