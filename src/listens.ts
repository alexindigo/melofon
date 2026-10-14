// src/listens.ts — app.listens: the append-only scrobble log. Rows are only
// ever INSERTed (no play_count column anywhere — stats are GROUP BY at read
// time). `source` names the hat that recorded the listen ('opensubsonic').
import type { Db } from './db.ts';
import { userIdForName } from './user.ts';

/** One user's plays of a catalog item, computed at read time. */
export interface Play {
  playCount: number;
  /** Epoch ms of the latest listen (null when never played). */
  lastPlayedMs: number | null;
}

export interface Listens {
  /** Appends one listen. false (nothing written) when the track is not a
   * catalog file. */
  record(
    username: string,
    trackId: string,
    opts: {
      source: string;
      /** Epoch ms; defaults to now() when the client sent no `time`. */
      playedAtMs?: number;
      durationMs?: number;
    },
  ): Promise<boolean>;
  /** Batch play facts for this user through current catalog membership: a
   * song counts its own listens, an album the listens of its files, an
   * artist the listens of files on the albums it is album artist of. Every
   * requested id is present (no listens → 0 plays, null date). */
  facts(
    username: string,
    ids: { songs?: string[]; albums?: string[]; artists?: string[] },
  ): Promise<{
    songs: Record<string, Play>;
    albums: Record<string, Play>;
    artists: Record<string, Play>;
  }>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createListens(db: Db): Listens {
  async function userId(username: string): Promise<string> {
    const id = await userIdForName(db, username);
    if (id === null) throw new Error(`unknown user: ${username}`);
    return id;
  }

  // One aggregate query per kind: `select` groups the user's listens by the
  // requested id (an IN list of the ids, deduplicated).
  async function plays(
    ids: string[] | undefined,
    select: (inList: string) => string,
  ): Promise<Record<string, Play>> {
    const out: Record<string, Play> = {};
    for (const id of ids ?? []) out[id] = { playCount: 0, lastPlayedMs: null };
    if (ids === undefined || ids.length === 0) return out;
    const res = await db.conn.runAndReadAll(
      select([...new Set(ids)].map(esc).join(', ')),
    );
    for (
      const row of res.getRowObjects() as {
        id: string;
        play_count: bigint | number;
        last_ms: bigint | number | null;
      }[]
    ) {
      out[row.id] = {
        playCount: Number(row.play_count),
        lastPlayedMs: row.last_ms === null ? null : Number(row.last_ms),
      };
    }
    return out;
  }

  return {
    async record(username, trackId, opts) {
      const userId_ = await userId(username);
      const known = await db.conn.runAndReadAll(
        `SELECT 1 FROM files WHERE id = ${esc(trackId)}`,
      );
      if (known.getRowObjects().length === 0) return false;
      const playedAt = opts.playedAtMs === undefined
        ? 'now()'
        : `to_timestamp(${Math.trunc(opts.playedAtMs) / 1000})`;
      const duration = opts.durationMs === undefined
        ? 'NULL'
        : String(Math.trunc(opts.durationMs));
      await db.conn.run(
        `INSERT INTO listens (user_id, track_id, played_at, duration_ms, source)
         VALUES (${esc(userId_)}, ${esc(trackId)}, ${playedAt}, ${duration}, ${
          esc(opts.source)
        })`,
      );
      return true;
    },

    async facts(username, ids) {
      const user = esc(await userId(username));
      const aggregate = 'COUNT(*) AS play_count, ' +
        'epoch_ms(MAX(li.played_at))::BIGINT AS last_ms';
      return {
        songs: await plays(
          ids.songs,
          (list) =>
            `SELECT li.track_id AS id, ${aggregate}
             FROM listens li
             WHERE li.user_id = ${user} AND li.track_id IN (${list})
             GROUP BY li.track_id`,
        ),
        albums: await plays(
          ids.albums,
          (list) =>
            `SELECT f.album_id AS id, ${aggregate}
             FROM files f
             JOIN listens li ON li.track_id = f.id AND li.user_id = ${user}
             WHERE f.album_id IN (${list})
             GROUP BY f.album_id`,
        ),
        artists: await plays(
          ids.artists,
          (list) =>
            `SELECT al.album_artist_id AS id, ${aggregate}
             FROM albums al
             JOIN files f ON f.album_id = al.id
             JOIN listens li ON li.track_id = f.id AND li.user_id = ${user}
             WHERE al.album_artist_id IN (${list})
             GROUP BY al.album_artist_id`,
        ),
      };
    },
  };
}
