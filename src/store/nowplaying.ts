import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { requireUserId } from './users.ts';

export interface NowPlayingRow {
  username: string;
  client: string;
  trackId: string;
  streamId: string | null;
  positionMs: number | null;
  startedAtMs: number;
  reportedAtMs: number;
  durationMs: number | null;
  state: 'starting' | 'playing' | 'paused';
  playbackRate: number;
  playerId: number;
}

export interface SessionExpiry {
  plannedBeforeMs: number;
  pausedBeforeMs: number;
}

export interface SessionUpdate {
  state: NowPlayingRow['state'];
  playbackRate: number;
  reportedAtMs: number;
  durationMs: number | null;
  restart: boolean;
}

/** Existing sessions gain real, retained player identities on upgrade. */
export async function upgradeNowPlaying(q: Queries): Promise<void> {
  await q.run(`INSERT INTO client_players (user_id, client)
    SELECT user_id, client FROM now_playing ORDER BY user_id, client
    ON CONFLICT (user_id, client) DO NOTHING`);
}

function expiredKeys(expiry: SessionExpiry): string {
  // Core supplies the policy cutoffs. Legacy rows use their original timestamp
  // and catalog duration, so a restart cannot give an old session a new lease.
  return `SELECT n.user_id, n.client FROM now_playing n
    LEFT JOIN files f ON f.id = n.track_id
    WHERE CASE WHEN n.state = 'paused' THEN
      epoch_ms(coalesce(n.reported_at, n.started_at)) <= ${expiry.pausedBeforeMs}
    ELSE epoch_ms(coalesce(n.reported_at, n.started_at)) +
      greatest(0, coalesce(n.duration_ms, f.duration_ms, 0) - coalesce(n.position_ms, 0)) /
      n.playback_rate <= ${expiry.plannedBeforeMs} END`;
}

async function rows(
  q: Queries,
  expiry?: SessionExpiry,
): Promise<NowPlayingRow[]> {
  const result = await q.all<{
    username: string;
    client: string;
    track_id: string;
    stream_id: string | null;
    position_ms: number | null;
    started_ms: number;
    reported_ms: number;
    duration_ms: number | null;
    state: NowPlayingRow['state'];
    playback_rate: number;
    player_id: number;
  }>(`SELECT u.name AS username, n.client, n.track_id, n.stream_id,
    n.position_ms, epoch_ms(n.started_at)::BIGINT AS started_ms,
    epoch_ms(coalesce(n.reported_at, n.started_at))::BIGINT AS reported_ms,
    coalesce(n.duration_ms, f.duration_ms) AS duration_ms,
    n.state, n.playback_rate, p.player_id
    FROM now_playing n JOIN users u ON u.id = n.user_id
    JOIN client_players p ON p.user_id = n.user_id AND p.client = n.client
    LEFT JOIN files f ON f.id = n.track_id
    ${
    expiry ? `WHERE (n.user_id, n.client) NOT IN (${expiredKeys(expiry)})` : ''
  }
    ORDER BY coalesce(n.reported_at, n.started_at) DESC, p.player_id DESC`);
  return result.map((r) => ({
    username: r.username,
    client: r.client,
    trackId: r.track_id,
    streamId: r.stream_id,
    positionMs: r.position_ms === null ? null : Number(r.position_ms),
    startedAtMs: Number(r.started_ms),
    reportedAtMs: Number(r.reported_ms),
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    state: r.state,
    playbackRate: Number(r.playback_rate),
    playerId: Number(r.player_id),
  }));
}

export function createNowPlayingStore(engine: Engine) {
  return {
    set(
      username: string,
      client: string,
      trackId: string,
      streamId: string,
      positionMs?: number,
      update?: SessionUpdate,
      expiry?: SessionExpiry,
    ): Promise<void> {
      return atomic(engine, async (q) => {
        const userId = esc(await requireUserId(q, username));
        // An offline report may replace an expired row before the next sweep.
        // It starts a new clock without deleting other rows behind the event owner.
        const restart = (update?.restart ?? true) || (expiry !== undefined &&
          !(await rows(q, expiry)).some((r) =>
            r.username === username && r.client === client &&
            r.trackId === trackId
          ));
        await q.run(`INSERT INTO client_players (user_id, client)
          VALUES (${userId}, ${
          esc(client)
        }) ON CONFLICT (user_id, client) DO NOTHING`);
        const at = update
          ? `epoch_ms(${Math.trunc(update.reportedAtMs)}::BIGINT)`
          : 'now()';
        await q.run(`INSERT INTO now_playing
          (user_id, client, track_id, stream_id, position_ms, started_at,
           reported_at, state, playback_rate, duration_ms)
          VALUES (${userId}, ${esc(client)}, ${esc(trackId)}, ${esc(streamId)},
            ${
          positionMs === undefined ? 'NULL' : Math.trunc(positionMs)
        }, ${at},
            ${at}, ${esc(update?.state ?? 'playing')}, ${
          update?.playbackRate ?? 1
        },
            ${update?.durationMs ?? 'NULL'})
          ON CONFLICT (user_id, client) DO UPDATE SET
            started_at = CASE WHEN now_playing.track_id <> excluded.track_id OR
              ${restart} THEN excluded.started_at ELSE now_playing.started_at END,
            track_id = excluded.track_id, stream_id = excluded.stream_id,
            position_ms = excluded.position_ms, reported_at = excluded.reported_at,
            state = excluded.state, playback_rate = excluded.playback_rate,
            duration_ms = excluded.duration_ms`);
      });
    },
    clearByStreamId(streamId: string): Promise<boolean> {
      return atomic(engine, async (q) => {
        const existing = await q.all(
          `SELECT 1 FROM now_playing WHERE stream_id = ${esc(streamId)}`,
        );
        if (!existing.length) return false;
        await q.run(
          `DELETE FROM now_playing WHERE stream_id = ${esc(streamId)}`,
        );
        return true;
      });
    },
    /** Claim a matching live session once; late/duplicate/expired stops cannot count. */
    take(
      username: string,
      client: string,
      trackId: string,
      expiry: SessionExpiry,
    ): Promise<NowPlayingRow | null> {
      return atomic(engine, async (q) => {
        const row = (await rows(q, expiry)).find((r) =>
          r.username === username && r.client === client &&
          r.trackId === trackId
        );
        if (!row) return null;
        await q.run(
          `DELETE FROM now_playing WHERE user_id = ${
            esc(await requireUserId(q, username))
          }
          AND client = ${esc(client)} AND track_id = ${esc(trackId)}`,
        );
        return row;
      });
    },
    list(expiry?: SessionExpiry): Promise<NowPlayingRow[]> {
      return engine.exclusive((q) => rows(q, expiry));
    },
    /** Only the lifecycle owner removes expired reports, then announces the result. */
    expire(expiry: SessionExpiry): Promise<number> {
      return atomic(engine, async (q) => {
        const removed = await q.all(`DELETE FROM now_playing
          WHERE (user_id, client) IN (${
          expiredKeys(expiry)
        }) RETURNING user_id`);
        return removed.length;
      });
    },
  };
}
