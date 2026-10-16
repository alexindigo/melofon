import { type Engine, esc, type Queries } from './engine.ts';
import { requireUserId } from './users.ts';

export interface PlaylistRow {
  id: string;
  name: string;
  comment: string | null;
  createdAtMs: number;
  changedAtMs: number;
  songCount: number;
  durationMs: number;
}

export interface PlaylistWithTracks extends PlaylistRow {
  trackIds: string[];
}

export interface PlaylistUpdate {
  name?: string;
  comment?: string;
  addTrackIds?: string[];
  removeAtPositions?: number[];
}

interface PlaylistSqlRow {
  id: string;
  name: string;
  comment: string | null;
  created_ms: number;
  changed_ms: number;
  song_count: number;
  duration_ms: number | null;
}

function playlistOf(row: PlaylistSqlRow): PlaylistRow {
  return {
    id: row.id,
    name: row.name,
    comment: row.comment,
    createdAtMs: Number(row.created_ms),
    changedAtMs: Number(row.changed_ms),
    songCount: Number(row.song_count),
    durationMs: Number(row.duration_ms ?? 0),
  };
}

const PLAYLIST_SELECT = `
  SELECT p.id, p.name, p.comment,
         epoch_ms(p.created_at)::BIGINT AS created_ms,
         epoch_ms(p.changed_at)::BIGINT AS changed_ms,
         COUNT(pt.track_id) AS song_count,
         COALESCE(SUM(f.duration_ms), 0) AS duration_ms
  FROM playlists p
  LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
  LEFT JOIN files f ON f.id = pt.track_id`;

async function trackIdsOf(q: Queries, playlistId: string): Promise<string[]> {
  const rows = await q.all<{ track_id: string }>(
    `SELECT track_id FROM playlist_tracks
       WHERE playlist_id = ${esc(playlistId)} ORDER BY position`,
  );
  return rows.map((r) => r.track_id);
}

async function rewriteTracks(
  q: Queries,
  playlistId: string,
  trackIds: string[],
): Promise<void> {
  await q.run(
    `DELETE FROM playlist_tracks WHERE playlist_id = ${esc(playlistId)}`,
  );
  for (let i = 0; i < trackIds.length; i++) {
    await q.run(
      `INSERT INTO playlist_tracks (playlist_id, position, track_id)
         VALUES (${esc(playlistId)}, ${i}, ${esc(trackIds[i])})`,
    );
  }
}

async function getOwned(
  q: Queries,
  userId_: string,
  id: string,
): Promise<PlaylistWithTracks | null> {
  const rows = await q.all<PlaylistSqlRow>(
    `${PLAYLIST_SELECT}
       WHERE p.id = ${esc(id)} AND p.user_id = ${esc(userId_)}
       GROUP BY p.id, p.name, p.comment, p.created_at, p.changed_at`,
  );
  const row = rows[0];
  if (!row) return null;
  return { ...playlistOf(row), trackIds: await trackIdsOf(q, id) };
}

async function bumpChanged(q: Queries, playlistId: string): Promise<void> {
  await q.run(
    `UPDATE playlists SET changed_at = now() WHERE id = ${esc(playlistId)}`,
  );
}

export function createPlaylistsStore(engine: Engine) {
  return {
    list(username: string): Promise<PlaylistRow[]> {
      return engine.exclusive(async (q) => {
        const userId_ = await requireUserId(q, username);
        const rows = await q.all<PlaylistSqlRow>(
          `${PLAYLIST_SELECT}
         WHERE p.user_id = ${esc(userId_)}
         GROUP BY p.id, p.name, p.comment, p.created_at, p.changed_at
         ORDER BY p.name`,
        );
        return rows.map(playlistOf);
      });
    },
    get(username: string, id: string): Promise<PlaylistWithTracks | null> {
      return engine.exclusive(async (q) =>
        getOwned(q, await requireUserId(q, username), id)
      );
    },
    create(
      username: string,
      name: string,
      trackIds: string[],
    ): Promise<PlaylistWithTracks> {
      return engine.exclusive(async (q) => {
        const userId_ = await requireUserId(q, username);
        const id = crypto.randomUUID();
        await q.run('BEGIN TRANSACTION');
        try {
          await q.run(
            `INSERT INTO playlists (id, user_id, name, created_at, changed_at)
           VALUES (${esc(id)}, ${esc(userId_)}, ${esc(name)}, now(), now())`,
          );
          await rewriteTracks(q, id, trackIds);
          await q.run('COMMIT');
        } catch (err) {
          await q.run('ROLLBACK');
          throw err;
        }
        return (await getOwned(q, userId_, id))!;
      });
    },
    setTracks(
      username: string,
      id: string,
      trackIds: string[],
    ): Promise<PlaylistWithTracks | null> {
      return engine.exclusive(async (q) => {
        const userId_ = await requireUserId(q, username);
        if ((await getOwned(q, userId_, id)) === null) return null;
        await q.run('BEGIN TRANSACTION');
        try {
          await rewriteTracks(q, id, trackIds);
          await bumpChanged(q, id);
          await q.run('COMMIT');
        } catch (err) {
          await q.run('ROLLBACK');
          throw err;
        }
        return await getOwned(q, userId_, id);
      });
    },
    update(
      username: string,
      id: string,
      opts: PlaylistUpdate,
    ): Promise<PlaylistWithTracks | null> {
      return engine.exclusive(async (q) => {
        const userId_ = await requireUserId(q, username);
        const existing = await getOwned(q, userId_, id);
        if (existing === null) return null;
        await q.run('BEGIN TRANSACTION');
        try {
          if (opts.name !== undefined) {
            await q.run(
              `UPDATE playlists SET name = ${esc(opts.name)} WHERE id = ${
                esc(id)
              }`,
            );
          }
          if (opts.comment !== undefined) {
            await q.run(
              `UPDATE playlists SET comment = ${esc(opts.comment)} WHERE id = ${
                esc(id)
              }`,
            );
          }
          let trackIds = existing.trackIds;
          if (opts.removeAtPositions !== undefined) {
            const drop = new Set(
              [...opts.removeAtPositions].sort((a, b) => b - a),
            );
            trackIds = trackIds.filter((_, i) => !drop.has(i));
          }
          if (opts.addTrackIds !== undefined) {
            trackIds = [...trackIds, ...opts.addTrackIds];
          }
          if (trackIds !== existing.trackIds) {
            await rewriteTracks(q, id, trackIds);
          }
          await bumpChanged(q, id);
          await q.run('COMMIT');
        } catch (err) {
          await q.run('ROLLBACK');
          throw err;
        }
        return await getOwned(q, userId_, id);
      });
    },
    delete(username: string, id: string): Promise<boolean> {
      return engine.exclusive(async (q) => {
        const userId_ = await requireUserId(q, username);
        if ((await getOwned(q, userId_, id)) === null) return false;
        await q.run('BEGIN TRANSACTION');
        try {
          await q.run(
            `DELETE FROM playlist_tracks WHERE playlist_id = ${esc(id)}`,
          );
          await q.run(`DELETE FROM playlists WHERE id = ${esc(id)}`);
          await q.run('COMMIT');
        } catch (err) {
          await q.run('ROLLBACK');
          throw err;
        }
        return true;
      });
    },
  };
}
