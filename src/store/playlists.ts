import { type Engine, esc, type Queries } from './engine.ts';
import { requireUserId } from './users.ts';
import { sortKeySql } from './catalog-sql.ts';

export interface PlaylistPageOptions {
  offset: number;
  limit: number;
  ignoredArticles?: string[];
}

export interface PlaylistPage {
  rows: PlaylistRow[];
  total: number;
}

export interface PlaylistRow {
  id: string;
  name: string;
  comment: string | null;
  owner: string;
  public: boolean;
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
  public?: boolean;
  addTrackIds?: string[];
  removeAtPositions?: number[];
}

interface PlaylistSqlRow {
  id: string;
  name: string;
  comment: string | null;
  owner: string;
  public: boolean;
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
    owner: row.owner,
    public: row.public,
    createdAtMs: Number(row.created_ms),
    changedAtMs: Number(row.changed_ms),
    songCount: Number(row.song_count),
    durationMs: Number(row.duration_ms ?? 0),
  };
}

const PLAYLIST_SELECT = `
  SELECT p.id, p.name, p.comment, u.name AS owner, p.public,
         epoch_ms(p.created_at)::BIGINT AS created_ms,
         epoch_ms(p.changed_at)::BIGINT AS changed_ms,
         COUNT(f.id) AS song_count,
         COALESCE(SUM(f.duration_ms), 0) AS duration_ms
  FROM playlists p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
  LEFT JOIN files f ON f.id = pt.track_id`;

async function trackIdsOf(q: Queries, playlistId: string): Promise<string[]> {
  const rows = await q.all<{ track_id: string }>(
    `SELECT pt.track_id FROM playlist_tracks pt JOIN files f ON f.id = pt.track_id
       WHERE pt.playlist_id = ${esc(playlistId)} ORDER BY pt.position`,
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
        GROUP BY p.id, p.name, p.comment, u.name, p.public, p.created_at, p.changed_at`,
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
    containingSong(
      songId: string,
      opts: PlaylistPageOptions,
      username?: string,
      includePublic = false,
    ): Promise<PlaylistPage | null> {
      return engine.exclusive(async (q) => {
        if (
          !(await q.all(`SELECT id FROM files WHERE id = ${esc(songId)}`))
            .length
        ) {
          return null;
        }
        const userId_ = username === undefined
          ? null
          : await requireUserId(q, username);
        const eligible = `EXISTS (
          SELECT 1 FROM playlist_tracks member
          WHERE member.playlist_id = p.id AND member.track_id = ${esc(songId)}
        ) AND ${
          userId_ === null
            ? 'true'
            : `(p.user_id = ${esc(userId_)}${
              includePublic ? ' OR p.public' : ''
            })`
        }`;
        const [{ total }] = await q.all<{ total: number }>(
          `SELECT COUNT(*) AS total FROM playlists p WHERE ${eligible}`,
        );
        const rows = await q.all<PlaylistSqlRow>(`${PLAYLIST_SELECT}
          WHERE ${eligible}
          GROUP BY p.id, p.name, p.comment, u.name, p.public, p.created_at, p.changed_at
          ORDER BY ${sortKeySql('p.name', opts.ignoredArticles)}, p.id
          LIMIT ${Math.max(0, Math.trunc(opts.limit))}
          OFFSET ${Math.max(0, Math.trunc(opts.offset))}`);
        return { rows: rows.map(playlistOf), total: Number(total) };
      });
    },
    list(username?: string, includePublic = false): Promise<PlaylistRow[]> {
      return engine.exclusive(async (q) => {
        const userId_ = username === undefined
          ? null
          : await requireUserId(q, username);
        const rows = await q.all<PlaylistSqlRow>(
          `${PLAYLIST_SELECT}
         WHERE ${
            userId_ === null
              ? 'true'
              : `(p.user_id = ${esc(userId_)}${
                includePublic ? ' OR p.public' : ''
              })`
          }
         GROUP BY p.id, p.name, p.comment, u.name, p.public, p.created_at, p.changed_at
         ORDER BY p.name, p.id`,
        );
        return rows.map(playlistOf);
      });
    },
    find(id: string): Promise<PlaylistWithTracks | null> {
      return engine.exclusive(async (q) => {
        const [row] = await q.all<PlaylistSqlRow>(`${PLAYLIST_SELECT}
          WHERE p.id = ${esc(id)}
          GROUP BY p.id, p.name, p.comment, u.name, p.public, p.created_at, p.changed_at`);
        return row
          ? { ...playlistOf(row), trackIds: await trackIdsOf(q, id) }
          : null;
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
      public_ = false,
    ): Promise<PlaylistWithTracks> {
      return engine.exclusive(async (q) => {
        const userId_ = await requireUserId(q, username);
        const id = crypto.randomUUID();
        await q.run('BEGIN TRANSACTION');
        try {
          await q.run(
            `INSERT INTO playlists (id, user_id, name, created_at, changed_at, public)
           VALUES (${esc(id)}, ${esc(userId_)}, ${
              esc(name)
            }, now(), now(), ${public_})`,
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
      public_?: boolean,
    ): Promise<PlaylistWithTracks | null> {
      return engine.exclusive(async (q) => {
        const userId_ = await requireUserId(q, username);
        if ((await getOwned(q, userId_, id)) === null) return null;
        await q.run('BEGIN TRANSACTION');
        try {
          await rewriteTracks(q, id, trackIds);
          if (public_ !== undefined) {
            await q.run(
              `UPDATE playlists SET public = ${public_} WHERE id = ${esc(id)}`,
            );
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
          if (opts.public !== undefined) {
            await q.run(
              `UPDATE playlists SET public = ${opts.public} WHERE id = ${
                esc(id)
              }`,
            );
          }
          // Resolve visible indices and edit the stored occurrences in this one
          // exclusive transaction. Orphans stay at their original relative place.
          const occurrences = await q.all<
            { track_id: string; visible: boolean }
          >(
            `SELECT pt.track_id, f.id IS NOT NULL AS visible FROM playlist_tracks pt
             LEFT JOIN files f ON f.id = pt.track_id
             WHERE pt.playlist_id = ${esc(id)} ORDER BY pt.position`,
          );
          let trackIds = occurrences.map((r) => r.track_id);
          if (opts.removeAtPositions !== undefined) {
            const drop = new Set(opts.removeAtPositions);
            let visibleIndex = 0;
            trackIds = occurrences.filter((row) =>
              !row.visible || !drop.has(visibleIndex++)
            ).map((row) => row.track_id);
          }
          if (opts.addTrackIds !== undefined) {
            trackIds = [...trackIds, ...opts.addTrackIds];
          }
          if (
            opts.removeAtPositions !== undefined ||
            opts.addTrackIds !== undefined
          ) {
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
