import { atomic, type Engine, esc } from './engine.ts';
import { requireUserId } from './users.ts';
import { folderMembership } from './catalog-sql.ts';

export type TargetType = 'song' | 'album' | 'artist';

export interface StarEvent {
  action: 'star' | 'unstar';
  atMs: number; // epoch milliseconds
}

export interface StarredItem {
  targetId: string;
  targetType: TargetType;
  /** All of this user's events for the item, ascending by seq. */
  events: StarEvent[];
}

export interface PersonalFacts {
  /** The user's latest event (by seq) for the item is a star. */
  starred: boolean;
  /** This user's events for the item, ascending by seq. */
  events: StarEvent[];
  /** This user's rating, 1..5. */
  userRating: number | null;
  /** AVG over all users' ratings, unrounded. */
  averageRating: number | null;
}

interface EventSqlRow {
  target_id: string;
  target_type: TargetType;
  action: 'star' | 'unstar';
  at_ms: number;
}

function eventOf(row: EventSqlRow): StarEvent {
  return { action: row.action, atMs: Number(row.at_ms) };
}

export function createAnnotationsStore(engine: Engine) {
  return {
    classify(username: string, targetId: string): Promise<TargetType | null> {
      return atomic(engine, async (q) => {
        await requireUserId(q, username);
        const id = esc(targetId);
        const rows = await q.all<{ kind: TargetType | null }>(
          `SELECT CASE
         WHEN EXISTS (SELECT 1 FROM artists WHERE id = ${id}) THEN 'artist'
         WHEN EXISTS (SELECT 1 FROM albums WHERE id = ${id}) THEN 'album'
         WHEN EXISTS (SELECT 1 FROM files WHERE id = ${id}) THEN 'song'
       END AS kind`,
        );
        return rows[0]?.kind ?? null;
      });
    },
    latestTargetType(
      username: string,
      targetId: string,
    ): Promise<TargetType | null> {
      return atomic(engine, async (q) => {
        const userId_ = await requireUserId(q, username);
        const rows = await q.all<{ target_type: TargetType }>(
          `SELECT target_type FROM star_events
           WHERE user_id = ${esc(userId_)} AND target_id = ${esc(targetId)}
           ORDER BY seq DESC LIMIT 1`,
        );
        return rows[0]?.target_type ?? null;
      });
    },
    appendStarEvent(
      username: string,
      targetId: string,
      targetType: TargetType,
      action: StarEvent['action'],
    ): Promise<void> {
      return atomic(engine, async (q) => {
        const userId_ = await requireUserId(q, username);
        await q.run(
          `INSERT INTO star_events (user_id, target_id, target_type, action, occurred_at)
       VALUES (${esc(userId_)}, ${esc(targetId)}, ${esc(targetType)}, ${
            esc(action)
          }, now())`,
        );
      });
    },
    setRating(
      username: string,
      targetId: string,
      rating: number,
    ): Promise<void> {
      return atomic(engine, async (q) => {
        const userId_ = await requireUserId(q, username);
        await q.run(
          `INSERT INTO ratings (user_id, target_id, rating)
         VALUES (${esc(userId_)}, ${esc(targetId)}, ${rating})
         ON CONFLICT (user_id, target_id) DO UPDATE SET
           rating = excluded.rating`,
        );
      });
    },
    clearRating(username: string, targetId: string): Promise<void> {
      return atomic(engine, async (q) => {
        const userId_ = await requireUserId(q, username);
        await q.run(
          `DELETE FROM ratings
           WHERE user_id = ${esc(userId_)} AND target_id = ${esc(targetId)}`,
        );
      });
    },
    starred(
      username: string,
      opts: { folderId?: string } = {},
    ): Promise<StarredItem[]> {
      return atomic(engine, async (q) => {
        const userId_ = await requireUserId(q, username);
        const folder = opts.folderId;
        const tables: Record<TargetType, string> = {
          song: 'files',
          album: 'albums',
          artist: 'artists',
        };
        const liveSql = (Object.keys(tables) as TargetType[]).map((type) => {
          const exists = `EXISTS (SELECT 1 FROM ${
            tables[type]
          } x WHERE x.id = l.target_id)`;
          const scope = folder === undefined
            ? ''
            : ` AND ${folderMembership[type]('l.target_id', folder)}`;
          return `(l.target_type = '${type}' AND ${exists}${scope})`;
        }).join(' OR ');
        const rows = await q.all<EventSqlRow>(
          `WITH latest AS (
           SELECT target_id, arg_max(action, seq) AS action,
                  arg_max(target_type, seq) AS target_type
           FROM star_events WHERE user_id = ${esc(userId_)}
           GROUP BY target_id
         ), live AS (
           SELECT l.target_id, l.target_type FROM latest l
           WHERE l.action = 'star' AND (${liveSql})
         )
         SELECT e.target_id, live.target_type, e.action,
                epoch_ms(e.occurred_at)::BIGINT AS at_ms
         FROM star_events e JOIN live ON live.target_id = e.target_id
         WHERE e.user_id = ${esc(userId_)}
         ORDER BY e.target_id, e.seq`,
        );
        const items: StarredItem[] = [];
        for (const row of rows) {
          const last = items[items.length - 1];
          if (last?.targetId === row.target_id) {
            last.events.push(eventOf(row));
          } else {
            items.push({
              targetId: row.target_id,
              targetType: row.target_type,
              events: [eventOf(row)],
            });
          }
        }
        return items;
      });
    },
    facts(
      username: string,
      targetIds: string[],
    ): Promise<Record<string, PersonalFacts>> {
      return atomic(engine, async (q) => {
        const userId_ = await requireUserId(q, username);
        const out: Record<string, PersonalFacts> = {};
        for (const id of targetIds) {
          out[id] = {
            starred: false,
            events: [],
            userRating: null,
            averageRating: null,
          };
        }
        if (targetIds.length === 0) return out;
        const ids = [...new Set(targetIds)].map(esc).join(', ');
        const events = await q.all<EventSqlRow>(
          `SELECT target_id, target_type, action,
                epoch_ms(occurred_at)::BIGINT AS at_ms
         FROM star_events
         WHERE user_id = ${esc(userId_)} AND target_id IN (${ids})
         ORDER BY target_id, seq`,
        );
        for (const row of events) {
          const facts = out[row.target_id];
          facts.events.push(eventOf(row));
          facts.starred = row.action === 'star';
        }
        const own = await q.all<{ target_id: string; rating: number }>(
          `SELECT target_id, rating FROM ratings
         WHERE user_id = ${esc(userId_)} AND target_id IN (${ids})`,
        );
        for (const row of own) {
          out[row.target_id].userRating = Number(row.rating);
        }
        const average = await q.all<{ target_id: string; average: number }>(
          `SELECT target_id, AVG(rating) AS average FROM ratings
         WHERE target_id IN (${ids})
         GROUP BY target_id`,
        );
        for (const row of average) {
          out[row.target_id].averageRating = Number(row.average);
        }
        return out;
      });
    },
    likes(targetId: string): Promise<{ likes: number; users: number }> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{ likes: number; users: number }>(
          `SELECT COUNT(*) AS likes, COUNT(DISTINCT user_id) AS users
         FROM star_events
         WHERE target_id = ${esc(targetId)} AND action = 'star'`,
        );
        return { likes: Number(rows[0].likes), users: Number(rows[0].users) };
      });
    },
  };
}
