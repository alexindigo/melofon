import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { requireUserId } from './users.ts';

export interface PlayQueueRow {
  trackIds: string[];
  currentIndex: number;
  positionMs: number;
  changedAtMs: number;
  changedBy: string | null;
}

/** Upgrade kept queues once, preserving the first occurrence of a legacy id. */
export async function upgradeClientQueues(
  q: Queries,
  schema: string,
): Promise<void> {
  const columns = await q.all<{ name: string }>(
    "PRAGMA table_info('play_queues')",
  );
  if (!columns.some((column) => column.name === 'current_id')) return;
  const definition = schema.split(';').find((sql) =>
    /CREATE TABLE IF NOT EXISTS play_queues\s*\(/.test(sql)
  );
  if (!definition) throw new Error('Missing canonical play queue schema');
  await q.run('BEGIN TRANSACTION');
  try {
    await q.run('ALTER TABLE play_queues RENAME TO play_queues_before_index');
    await q.run(definition);
    await q.run(`INSERT INTO play_queues
      (user_id, current_index, position_ms, changed_at, track_ids, changed_by)
      SELECT user_id, coalesce(list_position(track_ids, current_id) - 1, 0),
        coalesce(position_ms, 0), changed_at, track_ids, changed_by
      FROM play_queues_before_index`);
    await q.run('DROP TABLE play_queues_before_index');
    await q.run('COMMIT');
  } catch (error) {
    await q.run('ROLLBACK');
    throw error;
  }
}

export function createClientQueueStore(engine: Engine) {
  return {
    get(username: string): Promise<PlayQueueRow | null> {
      return atomic(engine, async (q) => {
        const userId = await requireUserId(q, username);
        const rows = await q.all<{
          current_index: number;
          position_ms: number | null;
          changed_ms: number;
          track_ids: string[];
          changed_by: string | null;
        }>(`SELECT current_index, position_ms,
                epoch_ms(changed_at)::BIGINT AS changed_ms, track_ids,
                changed_by
         FROM play_queues WHERE user_id = ${esc(userId)}`);
        const row = rows[0];
        if (!row || row.track_ids.length === 0) return null;
        // Retain original ordinals until the current entry is resolved. Filtering
        // ids first would shift the pointer, especially with duplicate tracks.
        const present = new Set((await q.all<{ id: string }>(
          `SELECT id FROM files WHERE id IN (${
            row.track_ids.map(esc).join(', ')
          })`,
        )).map(({ id }) => id));
        const entries = row.track_ids.map((id, index) => ({ id, index }))
          .filter(({ id }) => present.has(id));
        if (entries.length === 0) return null;
        let currentIndex = entries.findIndex(({ index }) =>
          index >= row.current_index
        );
        if (currentIndex === -1) currentIndex = entries.length - 1;
        const currentSurvives =
          entries[currentIndex].index === row.current_index;
        return {
          trackIds: entries.map(({ id }) => id),
          currentIndex,
          positionMs: currentSurvives ? Number(row.position_ms ?? 0) : 0,
          changedAtMs: Number(row.changed_ms),
          changedBy: row.changed_by,
        };
      });
    },
    save(
      username: string,
      queue: {
        trackIds: string[];
        currentIndex?: number;
        positionMs?: number;
        changedBy?: string;
      },
    ): Promise<void> {
      return atomic(engine, async (q) => {
        const userId = await requireUserId(q, username);
        if (queue.trackIds.length === 0) {
          await q.run(`DELETE FROM play_queues WHERE user_id = ${esc(userId)}`);
          return;
        }
        const current = queue.currentIndex ?? 0;
        if (
          !Number.isInteger(current) || current < 0 ||
          current >= queue.trackIds.length
        ) {
          throw new RangeError('Current queue index is out of range');
        }
        const position = queue.positionMs === undefined
          ? '0'
          : String(Math.trunc(queue.positionMs));
        const changedBy = queue.changedBy === undefined
          ? 'NULL'
          : esc(queue.changedBy);
        const trackIds = `[${queue.trackIds.map(esc).join(', ')}]`;
        await q.run(`INSERT INTO play_queues
           (user_id, current_index, position_ms, changed_at, track_ids,
            changed_by)
         VALUES (${esc(userId)}, ${current}, ${position}, now(), ${trackIds},
                 ${changedBy})
         ON CONFLICT (user_id) DO UPDATE SET
            current_index = excluded.current_index,
           position_ms = excluded.position_ms,
           changed_at = excluded.changed_at,
           track_ids = excluded.track_ids,
           changed_by = excluded.changed_by`);
      });
    },
  };
}
