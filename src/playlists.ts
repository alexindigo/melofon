// src/playlists.ts — app.playlists: per-user ordered track lists. The hat
// passes its state username; core resolves user_id and enforces ownership
// (another user's playlist is indistinguishable from a missing one).
// Positions are rewritten 0..n-1 on every mutation — no fractional ordering.
import type { Db } from './db.ts';
import { userIdForName } from './store/users.ts';

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

export interface Playlists {
  /** The caller's own playlists, by name. */
  list(username: string): Promise<PlaylistRow[]>;
  get(username: string, id: string): Promise<PlaylistWithTracks | null>;
  create(
    username: string,
    name: string,
    trackIds: string[],
  ): Promise<PlaylistWithTracks>;
  /** Replace the whole track list (Subsonic createPlaylist-by-playlistId). */
  setTracks(
    username: string,
    id: string,
    trackIds: string[],
  ): Promise<PlaylistWithTracks | null>;
  /** Metadata edits + incremental adds/removes (Subsonic updatePlaylist). */
  update(
    username: string,
    id: string,
    opts: {
      name?: string;
      comment?: string;
      addTrackIds?: string[];
      removeAtPositions?: number[];
    },
  ): Promise<PlaylistWithTracks | null>;
  delete(username: string, id: string): Promise<boolean>;
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface PlaylistSqlRow {
  id: string;
  name: string;
  comment: string | null;
  created_ms: bigint | number;
  changed_ms: bigint | number;
  song_count: bigint | number;
  duration_ms: bigint | number | null;
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

export function createPlaylists(db: Db): Playlists {
  async function userId(username: string): Promise<string> {
    const id = await userIdForName(db, username);
    if (id === null) throw new Error(`unknown user: ${username}`);
    return id;
  }

  async function trackIdsOf(playlistId: string): Promise<string[]> {
    const res = await db.conn.runAndReadAll(
      `SELECT track_id FROM playlist_tracks
       WHERE playlist_id = ${esc(playlistId)} ORDER BY position`,
    );
    return (res.getRowObjects() as { track_id: string }[]).map((r) =>
      r.track_id
    );
  }

  async function rewriteTracks(
    playlistId: string,
    trackIds: string[],
  ): Promise<void> {
    await db.conn.run(
      `DELETE FROM playlist_tracks WHERE playlist_id = ${esc(playlistId)}`,
    );
    for (let i = 0; i < trackIds.length; i++) {
      await db.conn.run(
        `INSERT INTO playlist_tracks (playlist_id, position, track_id)
         VALUES (${esc(playlistId)}, ${i}, ${esc(trackIds[i])})`,
      );
    }
  }

  async function getOwned(
    userId_: string,
    id: string,
  ): Promise<PlaylistWithTracks | null> {
    const res = await db.conn.runAndReadAll(
      `${PLAYLIST_SELECT}
       WHERE p.id = ${esc(id)} AND p.user_id = ${esc(userId_)}
       GROUP BY p.id, p.name, p.comment, p.created_at, p.changed_at`,
    );
    const row = (res.getRowObjects() as unknown as PlaylistSqlRow[])[0];
    if (!row) return null;
    return { ...playlistOf(row), trackIds: await trackIdsOf(id) };
  }

  async function bumpChanged(playlistId: string): Promise<void> {
    await db.conn.run(
      `UPDATE playlists SET changed_at = now() WHERE id = ${esc(playlistId)}`,
    );
  }

  return {
    async list(username) {
      const userId_ = await userId(username);
      const res = await db.conn.runAndReadAll(
        `${PLAYLIST_SELECT}
         WHERE p.user_id = ${esc(userId_)}
         GROUP BY p.id, p.name, p.comment, p.created_at, p.changed_at
         ORDER BY p.name`,
      );
      return (res.getRowObjects() as unknown as PlaylistSqlRow[]).map(
        playlistOf,
      );
    },

    async get(username, id) {
      return await getOwned(await userId(username), id);
    },

    async create(username, name, trackIds) {
      const userId_ = await userId(username);
      const id = crypto.randomUUID();
      await db.conn.run('BEGIN TRANSACTION');
      try {
        await db.conn.run(
          `INSERT INTO playlists (id, user_id, name, created_at, changed_at)
           VALUES (${esc(id)}, ${esc(userId_)}, ${esc(name)}, now(), now())`,
        );
        await rewriteTracks(id, trackIds);
        await db.conn.run('COMMIT');
      } catch (err) {
        await db.conn.run('ROLLBACK');
        throw err;
      }
      return (await getOwned(userId_, id))!;
    },

    async setTracks(username, id, trackIds) {
      const userId_ = await userId(username);
      if ((await getOwned(userId_, id)) === null) return null;
      await db.conn.run('BEGIN TRANSACTION');
      try {
        await rewriteTracks(id, trackIds);
        await bumpChanged(id);
        await db.conn.run('COMMIT');
      } catch (err) {
        await db.conn.run('ROLLBACK');
        throw err;
      }
      return await getOwned(userId_, id);
    },

    async update(username, id, opts) {
      const userId_ = await userId(username);
      const existing = await getOwned(userId_, id);
      if (existing === null) return null;
      await db.conn.run('BEGIN TRANSACTION');
      try {
        if (opts.name !== undefined) {
          await db.conn.run(
            `UPDATE playlists SET name = ${esc(opts.name)} WHERE id = ${
              esc(id)
            }`,
          );
        }
        if (opts.comment !== undefined) {
          await db.conn.run(
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
        if (trackIds !== existing.trackIds) await rewriteTracks(id, trackIds);
        await bumpChanged(id);
        await db.conn.run('COMMIT');
      } catch (err) {
        await db.conn.run('ROLLBACK');
        throw err;
      }
      return await getOwned(userId_, id);
    },

    async delete(username, id) {
      const userId_ = await userId(username);
      if ((await getOwned(userId_, id)) === null) return false;
      await db.conn.run('BEGIN TRANSACTION');
      try {
        await db.conn.run(
          `DELETE FROM playlist_tracks WHERE playlist_id = ${esc(id)}`,
        );
        await db.conn.run(
          `DELETE FROM playlists WHERE id = ${esc(id)}`,
        );
        await db.conn.run('COMMIT');
      } catch (err) {
        await db.conn.run('ROLLBACK');
        throw err;
      }
      return true;
    },
  };
}
