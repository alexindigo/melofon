import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { requireUserId } from './users.ts';

export interface Play {
  playCount: number;
  lastPlayedMs: number | null;
}

async function plays(
  q: Queries,
  ids: string[] | undefined,
  select: (inList: string) => string,
): Promise<Record<string, Play>> {
  const out: Record<string, Play> = {};
  for (const id of ids ?? []) out[id] = { playCount: 0, lastPlayedMs: null };
  if (ids === undefined || ids.length === 0) return out;
  const rows = await q.all<
    { id: string; play_count: number; last_ms: number | null }
  >(select([...new Set(ids)].map(esc).join(', ')));
  for (const row of rows) {
    out[row.id] = {
      playCount: Number(row.play_count),
      lastPlayedMs: row.last_ms === null ? null : Number(row.last_ms),
    };
  }
  return out;
}

export interface ListenAppend {
  source: string;
  playedAtMs?: number;
  durationMs?: number;
}

/** Store-local writer: the caller owns the exclusive transaction, never nests it. */
export async function appendListen(
  q: Queries,
  username: string,
  trackId: string,
  opts: ListenAppend,
): Promise<boolean> {
  const userId = await requireUserId(q, username);
  const known = await q.all(`SELECT 1 FROM files WHERE id = ${esc(trackId)}`);
  if (known.length === 0) return false;
  const playedAt = opts.playedAtMs === undefined
    ? 'now()'
    : `to_timestamp(${Math.trunc(opts.playedAtMs) / 1000})`;
  const duration = opts.durationMs === undefined
    ? 'NULL'
    : String(Math.trunc(opts.durationMs));
  await q.run(
    `INSERT INTO listens (user_id, track_id, played_at, duration_ms, source)
     VALUES (${esc(userId)}, ${esc(trackId)}, ${playedAt}, ${duration}, ${
      esc(opts.source)
    })`,
  );
  return true;
}

export function createListensStore(engine: Engine) {
  return {
    record(
      username: string,
      trackId: string,
      opts: ListenAppend,
    ): Promise<boolean> {
      return atomic(engine, (q) => appendListen(q, username, trackId, opts));
    },
    facts(
      username: string,
      ids: { songs?: string[]; albums?: string[]; artists?: string[] },
    ) {
      return atomic(engine, async (q) => {
        const user = esc(await requireUserId(q, username));
        const aggregate = 'COUNT(*) AS play_count, ' +
          'epoch_ms(MAX(li.played_at))::BIGINT AS last_ms';
        return {
          songs: await plays(
            q,
            ids.songs,
            (list) =>
              `SELECT li.track_id AS id, ${aggregate}
             FROM listens li
             WHERE li.user_id = ${user} AND li.track_id IN (${list})
             GROUP BY li.track_id`,
          ),
          albums: await plays(
            q,
            ids.albums,
            (list) =>
              `SELECT f.album_id AS id, ${aggregate}
             FROM files f
             JOIN listens li ON li.track_id = f.id AND li.user_id = ${user}
             WHERE f.album_id IN (${list})
             GROUP BY f.album_id`,
          ),
          artists: await plays(
            q,
            ids.artists,
            (list) =>
              `SELECT f.artist_id AS id, ${aggregate}
             FROM files f
             JOIN listens li ON li.track_id = f.id AND li.user_id = ${user}
             WHERE f.artist_id IN (${list})
             GROUP BY f.artist_id`,
          ),
        };
      });
    },
  };
}
