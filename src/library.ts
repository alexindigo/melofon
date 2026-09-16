// src/library.ts — app.library: read-side catalog queries over the DuckDB
// index. Returns domain rows only — protocol shapes (ID3 payloads, XML/JSON)
// are the hats' job. No DuckDB handle ever leaves core: layers get this
// namespace on context.app.library.
import type { Db } from './db.ts';

export interface ArtistRow {
  id: string;
  name: string;
  albumCount: number;
}

export interface AlbumRow {
  id: string;
  name: string;
  artistId: string;
  artistName: string;
  songCount: number;
  durationMs: number;
}

export interface SongRow {
  id: string;
  path: string;
  title: string;
  albumId: string | null;
  albumName: string | null;
  artistId: string | null;
  artistName: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
  size: number | null;
  suffix: string;
  contentType: string;
}

export interface Search3Result {
  artists: ArtistRow[];
  albums: AlbumRow[];
  songs: SongRow[];
}

export interface Library {
  /** Album artists (artists with at least one album), alphabetically. */
  listArtists(): Promise<ArtistRow[]>;
  /** One album artist by ID (null when unknown or has no albums). */
  getArtist(id: string): Promise<ArtistRow | null>;
  /** Albums of one album artist, alphabetically. */
  albumsByArtist(artistId: string): Promise<AlbumRow[]>;
  /** Album lists for getAlbumList2-shaped hats. */
  listAlbums(opts: {
    sort: 'name' | 'random' | 'newest';
    size: number;
    offset: number;
  }): Promise<AlbumRow[]>;
  getAlbum(id: string): Promise<{ album: AlbumRow; songs: SongRow[] } | null>;
  getSong(id: string): Promise<SongRow | null>;
  search3(
    query: string,
    opts: {
      artistCount: number;
      artistOffset: number;
      albumCount: number;
      albumOffset: number;
      songCount: number;
      songOffset: number;
    },
  ): Promise<Search3Result>;
  /** Absolute path of a song's audio file, for app.stream. */
  songPath(id: string): Promise<string | null>;
  /** Random songs from the catalog (getRandomSongs pull-forward). */
  randomSongs(size: number): Promise<SongRow[]>;
  /** Absolute path of an album's cover.jpg, for app.artwork (null if none). */
  albumCoverPath(id: string): Promise<string | null>;
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
};

function suffixOf(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? '' : path.slice(idx + 1).toLowerCase();
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function esc(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface SongSqlRow {
  id: string;
  path: string;
  title: string;
  album_id: string | null;
  album_name: string | null;
  artist_id: string | null;
  artist_name: string | null;
  track: number | null;
  disc: number | null;
  duration_ms: number | bigint | null;
  size: number | bigint | null;
}

function songOf(row: SongSqlRow): SongRow {
  const suffix = suffixOf(row.path);
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    albumId: row.album_id,
    albumName: row.album_name,
    artistId: row.artist_id,
    artistName: row.artist_name,
    track: num(row.track),
    disc: num(row.disc),
    durationMs: num(row.duration_ms),
    size: num(row.size),
    suffix,
    contentType: CONTENT_TYPES[suffix] ?? 'application/octet-stream',
  };
}

const SONG_SELECT = `
  SELECT f.id, f.path, f.title, f.album_id, al.name AS album_name,
         f.artist_id, ar.name AS artist_name, f.track, f.disc,
         f.duration_ms, f.size
  FROM files f
  LEFT JOIN albums al ON al.id = f.album_id
  LEFT JOIN artists ar ON ar.id = f.artist_id`;

interface AlbumSqlRow {
  id: string;
  name: string;
  album_artist_id: string;
  artist_name: string;
  song_count: number | bigint;
  duration_ms: number | bigint | null;
}

function albumOf(row: AlbumSqlRow): AlbumRow {
  return {
    id: row.id,
    name: row.name,
    artistId: row.album_artist_id,
    artistName: row.artist_name,
    songCount: Number(row.song_count),
    durationMs: Number(row.duration_ms ?? 0),
  };
}

const ALBUM_SELECT = `
  SELECT al.id, al.name, al.album_artist_id, ar.name AS artist_name,
         COUNT(f.id) AS song_count, COALESCE(SUM(f.duration_ms), 0) AS duration_ms
  FROM albums al
  JOIN artists ar ON ar.id = al.album_artist_id
  LEFT JOIN files f ON f.album_id = al.id
  GROUP BY al.id, al.name, al.album_artist_id, ar.name`;

export function createLibrary(db: Db): Library {
  return {
    async listArtists(): Promise<ArtistRow[]> {
      const res = await db.conn.runAndReadAll(
        `SELECT ar.id, ar.name, COUNT(al.id) AS album_count
         FROM artists ar
         JOIN albums al ON al.album_artist_id = ar.id
         GROUP BY ar.id, ar.name
         ORDER BY ar.name`,
      );
      return (res.getRowObjects() as {
        id: string;
        name: string;
        album_count: number | bigint;
      }[]).map((row) => ({
        id: row.id,
        name: row.name,
        albumCount: Number(row.album_count),
      }));
    },

    async getArtist(id) {
      const res = await db.conn.runAndReadAll(
        `SELECT ar.id, ar.name, COUNT(al.id) AS album_count
         FROM artists ar
         JOIN albums al ON al.album_artist_id = ar.id
         WHERE ar.id = ${esc(id)}
         GROUP BY ar.id, ar.name`,
      );
      const row = (res.getRowObjects() as {
        id: string;
        name: string;
        album_count: number | bigint;
      }[])[0];
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        albumCount: Number(row.album_count),
      };
    },

    async albumsByArtist(artistId) {
      const res = await db.conn.runAndReadAll(
        `${ALBUM_SELECT} HAVING al.album_artist_id = ${esc(artistId)}
         ORDER BY al.name`,
      );
      return (res.getRowObjects() as unknown as AlbumSqlRow[]).map(albumOf);
    },

    async listAlbums(opts) {
      const order = opts.sort === 'random'
        ? 'ORDER BY RANDOM()'
        : opts.sort === 'newest'
        ? 'ORDER BY MAX(f.mtime) DESC NULLS LAST'
        : 'ORDER BY al.name';
      const res = await db.conn.runAndReadAll(
        `${ALBUM_SELECT} ${order} LIMIT ${opts.size} OFFSET ${opts.offset}`,
      );
      return (res.getRowObjects() as unknown as AlbumSqlRow[]).map(albumOf);
    },

    async getAlbum(id) {
      const albumRes = await db.conn.runAndReadAll(
        `${ALBUM_SELECT} HAVING al.id = ${esc(id)}`,
      );
      const albumRow =
        (albumRes.getRowObjects() as unknown as AlbumSqlRow[])[0];
      if (!albumRow) return null;
      const songRes = await db.conn.runAndReadAll(
        `${SONG_SELECT} WHERE f.album_id = ${esc(id)}
         ORDER BY f.disc, f.track, f.path`,
      );
      return {
        album: albumOf(albumRow),
        songs: (songRes.getRowObjects() as unknown as SongSqlRow[]).map(songOf),
      };
    },

    async getSong(id) {
      const res = await db.conn.runAndReadAll(
        `${SONG_SELECT} WHERE f.id = ${esc(id)}`,
      );
      const row = (res.getRowObjects() as unknown as SongSqlRow[])[0];
      return row ? songOf(row) : null;
    },

    async search3(query, opts) {
      const like = `'%' || ${esc(query)} || '%'`;
      const [artistRes, albumRes, songRes] = await Promise.all([
        db.conn.runAndReadAll(
          `SELECT ar.id, ar.name, COUNT(al.id) AS album_count
           FROM artists ar
           JOIN albums al ON al.album_artist_id = ar.id
           WHERE ar.name ILIKE ${like}
           GROUP BY ar.id, ar.name
           ORDER BY ar.name
           LIMIT ${opts.artistCount} OFFSET ${opts.artistOffset}`,
        ),
        db.conn.runAndReadAll(
          `${ALBUM_SELECT} HAVING al.name ILIKE ${like}
           ORDER BY al.name
           LIMIT ${opts.albumCount} OFFSET ${opts.albumOffset}`,
        ),
        db.conn.runAndReadAll(
          `${SONG_SELECT} WHERE f.title ILIKE ${like}
           ORDER BY f.title
           LIMIT ${opts.songCount} OFFSET ${opts.songOffset}`,
        ),
      ]);
      return {
        artists: (artistRes.getRowObjects() as {
          id: string;
          name: string;
          album_count: number | bigint;
        }[]).map((row) => ({
          id: row.id,
          name: row.name,
          albumCount: Number(row.album_count),
        })),
        albums: (albumRes.getRowObjects() as unknown as AlbumSqlRow[]).map(
          albumOf,
        ),
        songs: (songRes.getRowObjects() as unknown as SongSqlRow[]).map(songOf),
      };
    },

    async songPath(id) {
      const res = await db.conn.runAndReadAll(
        `SELECT path FROM files WHERE id = ${esc(id)}`,
      );
      const row = (res.getRowObjects() as { path: string }[])[0];
      return row?.path ?? null;
    },

    async randomSongs(size) {
      const res = await db.conn.runAndReadAll(
        `${SONG_SELECT} ORDER BY RANDOM() LIMIT ${Math.trunc(size)}`,
      );
      return (res.getRowObjects() as unknown as SongSqlRow[]).map(songOf);
    },

    async albumCoverPath(id) {
      const res = await db.conn.runAndReadAll(
        `SELECT path FROM files WHERE album_id = ${
          esc(id)
        } ORDER BY path LIMIT 1`,
      );
      const row = (res.getRowObjects() as { path: string }[])[0];
      if (!row) return null;
      const dir = row.path.slice(0, row.path.lastIndexOf('/'));
      const cover = `${dir}/cover.jpg`;
      try {
        const stat = await Deno.stat(cover);
        return stat.isFile ? cover : null;
      } catch {
        return null;
      }
    },
  };
}
