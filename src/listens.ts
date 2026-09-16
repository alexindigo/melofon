// src/listens.ts — app.listens: the append-only scrobble log. Rows are only
// ever INSERTed (no play_count column anywhere — stats are GROUP BY at read
// time). `source` names the hat that recorded the listen ('opensubsonic').
import type { Db } from './db.ts';
import { userIdForName } from './user.ts';

export interface Listens {
  record(
    username: string,
    trackId: string,
    opts: {
      source: string;
      /** Epoch ms; defaults to now() when the client sent no `time`. */
      playedAtMs?: number;
      durationMs?: number;
    },
  ): Promise<void>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createListens(db: Db): Listens {
  return {
    async record(username, trackId, opts) {
      const userId = await userIdForName(db, username);
      if (userId === null) throw new Error(`unknown user: ${username}`);
      const playedAt = opts.playedAtMs === undefined
        ? 'now()'
        : `to_timestamp(${Math.trunc(opts.playedAtMs) / 1000})`;
      const duration = opts.durationMs === undefined
        ? 'NULL'
        : String(Math.trunc(opts.durationMs));
      await db.conn.run(
        `INSERT INTO listens (user_id, track_id, played_at, duration_ms, source)
         VALUES (${esc(userId)}, ${esc(trackId)}, ${playedAt}, ${duration}, ${
          esc(opts.source)
        })`,
      );
    },
  };
}
