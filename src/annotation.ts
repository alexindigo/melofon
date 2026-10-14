// src/annotation.ts — app.annotation: per-user star history and ratings. The
// hat passes its state username; core resolves the internal user_id
// (users.id) so state tables never expose it to the layer. Keep-on-rescan:
// nothing here touches the catalog tables and the scan never touches these.
//
// Stars are an append-only event log (star_events): every star and unstar is
// one row, nothing is overwritten or deleted. An item is starred now when the
// user's latest event for it (by seq) is a star; every star event is a like.
// Core reports those facts and the raw events; protocol dates and orders
// (e.g. OpenSubsonic's "most recent like") are derived by the hats.
import type { Db } from './db.ts';
import { folderMembership } from './library.ts';
import { userIdForName } from './user.ts';

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

export interface Annotation {
  /** Appends a star (a like) for a catalog id, even if already starred.
   * false (nothing written) when the id is no artist, album or song. */
  star(username: string, targetId: string): Promise<boolean>;
  /** Appends an unstar. An id that left the catalog keeps the type of the
   * user's latest event for it; false (nothing written) when it has none. */
  unstar(username: string, targetId: string): Promise<boolean>;
  /** Subsonic 1..5; 0 clears the rating row. false (nothing written) when
   * the id is no artist, album or song. */
  setRating(
    username: string,
    targetId: string,
    rating: number,
  ): Promise<boolean>;
  /** Items starred now that still exist (optionally only those in one
   * source), each with its events; ordered by targetId. */
  starred(
    username: string,
    opts?: { folderId?: string },
  ): Promise<StarredItem[]>;
  /** Batch facts: every requested id is present (missing data → not
   * starred, no events, null ratings). Orphans are not filtered. */
  facts(
    username: string,
    targetIds: string[],
  ): Promise<Record<string, PersonalFacts>>;
  /** Across all users: star events for the id and distinct users with one. */
  likes(targetId: string): Promise<{ likes: number; users: number }>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function inList(ids: string[]): string {
  return [...new Set(ids)].map(esc).join(', ');
}

interface EventSqlRow {
  target_id: string;
  target_type: TargetType;
  action: 'star' | 'unstar';
  at_ms: bigint | number;
}

function eventOf(row: EventSqlRow): StarEvent {
  return { action: row.action, atMs: Number(row.at_ms) };
}

export function createAnnotation(db: Db): Annotation {
  async function userId(username: string): Promise<string> {
    const id = await userIdForName(db, username);
    if (id === null) throw new Error(`unknown user: ${username}`);
    return id;
  }

  // Catalog ids are kind-prefixed hashes, so at most one table matches and
  // the CASE order never changes the result.
  async function classify(targetId: string): Promise<TargetType | null> {
    const id = esc(targetId);
    const res = await db.conn.runAndReadAll(
      `SELECT CASE
         WHEN EXISTS (SELECT 1 FROM artists WHERE id = ${id}) THEN 'artist'
         WHEN EXISTS (SELECT 1 FROM albums WHERE id = ${id}) THEN 'album'
         WHEN EXISTS (SELECT 1 FROM files WHERE id = ${id}) THEN 'song'
       END AS kind`,
    );
    const row = (res.getRowObjects() as { kind: TargetType | null }[])[0];
    return row?.kind ?? null;
  }

  async function append(
    userId_: string,
    targetId: string,
    targetType: TargetType,
    action: 'star' | 'unstar',
  ): Promise<void> {
    await db.conn.run(
      `INSERT INTO star_events (user_id, target_id, target_type, action, "at")
       VALUES (${esc(userId_)}, ${esc(targetId)}, ${esc(targetType)}, ${
        esc(action)
      }, now())`,
    );
  }

  return {
    async star(username, targetId) {
      const userId_ = await userId(username);
      const type = await classify(targetId);
      if (type === null) return false;
      await append(userId_, targetId, type, 'star');
      return true;
    },

    async unstar(username, targetId) {
      const userId_ = await userId(username);
      let type = await classify(targetId);
      if (type === null) {
        const res = await db.conn.runAndReadAll(
          `SELECT target_type FROM star_events
           WHERE user_id = ${esc(userId_)} AND target_id = ${esc(targetId)}
           ORDER BY seq DESC LIMIT 1`,
        );
        const row = (res.getRowObjects() as { target_type: TargetType }[])[0];
        if (row === undefined) return false;
        type = row.target_type;
      }
      await append(userId_, targetId, type, 'unstar');
      return true;
    },

    async setRating(username, targetId, rating) {
      const userId_ = await userId(username);
      if (await classify(targetId) === null) return false;
      if (rating === 0) {
        await db.conn.run(
          `DELETE FROM ratings
           WHERE user_id = ${esc(userId_)} AND target_id = ${esc(targetId)}`,
        );
        return true;
      }
      await db.conn.run(
        `INSERT INTO ratings (user_id, target_id, rating)
         VALUES (${esc(userId_)}, ${esc(targetId)}, ${rating})
         ON CONFLICT (user_id, target_id) DO UPDATE SET
           rating = excluded.rating`,
      );
      return true;
    },

    async starred(username, opts = {}) {
      const userId_ = await userId(username);
      const folder = opts.folderId;
      const tables: Record<TargetType, string> = {
        song: 'files',
        album: 'albums',
        artist: 'artists',
      };
      // Still in the catalog (and, with a folder, in that source).
      const liveSql = (Object.keys(tables) as TargetType[]).map((type) => {
        const exists = `EXISTS (SELECT 1 FROM ${
          tables[type]
        } x WHERE x.id = l.target_id)`;
        const scope = folder === undefined
          ? ''
          : ` AND ${folderMembership[type]('l.target_id', folder)}`;
        return `(l.target_type = '${type}' AND ${exists}${scope})`;
      }).join(' OR ');
      const res = await db.conn.runAndReadAll(
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
                epoch_ms(e."at")::BIGINT AS at_ms
         FROM star_events e JOIN live ON live.target_id = e.target_id
         WHERE e.user_id = ${esc(userId_)}
         ORDER BY e.target_id, e.seq`,
      );
      const items: StarredItem[] = [];
      for (const row of res.getRowObjects() as unknown as EventSqlRow[]) {
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
    },

    async facts(username, targetIds) {
      const userId_ = await userId(username);
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
      const ids = inList(targetIds);
      const events = await db.conn.runAndReadAll(
        `SELECT target_id, target_type, action,
                epoch_ms("at")::BIGINT AS at_ms
         FROM star_events
         WHERE user_id = ${esc(userId_)} AND target_id IN (${ids})
         ORDER BY target_id, seq`,
      );
      for (const row of events.getRowObjects() as unknown as EventSqlRow[]) {
        const facts = out[row.target_id];
        facts.events.push(eventOf(row));
        facts.starred = row.action === 'star';
      }
      const own = await db.conn.runAndReadAll(
        `SELECT target_id, rating FROM ratings
         WHERE user_id = ${esc(userId_)} AND target_id IN (${ids})`,
      );
      for (
        const row of own.getRowObjects() as {
          target_id: string;
          rating: number;
        }[]
      ) {
        out[row.target_id].userRating = Number(row.rating);
      }
      const average = await db.conn.runAndReadAll(
        `SELECT target_id, AVG(rating) AS average FROM ratings
         WHERE target_id IN (${ids})
         GROUP BY target_id`,
      );
      for (
        const row of average.getRowObjects() as {
          target_id: string;
          average: number;
        }[]
      ) {
        out[row.target_id].averageRating = Number(row.average);
      }
      return out;
    },

    async likes(targetId) {
      const res = await db.conn.runAndReadAll(
        `SELECT COUNT(*) AS likes, COUNT(DISTINCT user_id) AS users
         FROM star_events
         WHERE target_id = ${esc(targetId)} AND action = 'star'`,
      );
      const row = res.getRowObjects()[0] as {
        likes: bigint | number;
        users: bigint | number;
      };
      return { likes: Number(row.likes), users: Number(row.users) };
    },
  };
}
