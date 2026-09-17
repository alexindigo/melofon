// src/library.ts — app.library: read-side catalog queries over the DuckDB
// index. Returns domain rows only — protocol shapes (ID3 payloads, XML/JSON)
// are the hats' job. No DuckDB handle ever leaves core: layers get this
// namespace on context.app.library.
import { parseFile } from 'music-metadata';
import type { Db } from './db.ts';
import { userIdForName } from './user.ts';

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
  /** Newest song year on the album (null when no song carries a year). */
  year: number | null;
  /** Newest file mtime on the album — the wire's AlbumID3.created ("date the
   * album was added"; the catalog rebuild makes a row-creation time
   * meaningless). Null only when the album has no files. */
  createdAtMs: number | null;
}

export interface SongRow {
  id: string;
  path: string;
  /** Source this file was scanned from (null only for pre-M3 rows). */
  libraryId: string | null;
  /** Absolute path of that source's root — hats relativize `path` against it. */
  libraryPath: string | null;
  title: string;
  albumId: string | null;
  albumName: string | null;
  artistId: string | null;
  artistName: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
  size: number | null;
  genre: string | null;
  year: number | null;
  /** M4: row is a music video (probe-decided at scan), else an audio file. */
  isVideo: boolean;
  suffix: string;
  contentType: string;
}

export interface GenreRow {
  name: string;
  songCount: number;
  albumCount: number;
}

export interface LyricsRow {
  artist: string | null;
  title: string | null;
  text: string;
}

export interface Search3Result {
  artists: ArtistRow[];
  albums: AlbumRow[];
  songs: SongRow[];
}

export interface Library {
  /** Album artists (artists with at least one album), alphabetically. */
  listArtists(folderId?: string): Promise<ArtistRow[]>;
  /** One album artist by ID (null when unknown or has no albums). */
  getArtist(id: string): Promise<ArtistRow | null>;
  /** Albums of one album artist, alphabetically. */
  albumsByArtist(artistId: string): Promise<AlbumRow[]>;
  /** Album lists for getAlbumList/getAlbumList2-shaped hats. The user-scoped
   * sorts (starred / highest / frequent / recent) need `username`; `genre`
   * sort needs `genre`. */
  listAlbums(opts: {
    sort:
      | 'name'
      | 'artist'
      | 'random'
      | 'newest'
      | 'starred'
      | 'highest'
      | 'frequent'
      | 'recent'
      | 'genre'
      | 'year';
    size: number;
    offset: number;
    folderId?: string;
    genre?: string;
    username?: string;
    /** `year` sort: range bounds (either order; from > to is newest-first). */
    fromYear?: number;
    toYear?: number;
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
      folderId?: string;
    },
  ): Promise<Search3Result>;
  /** Absolute path of a song's audio file, for app.stream. */
  songPath(id: string): Promise<string | null>;
  /** All music videos in the catalog (getVideos). */
  videos(): Promise<SongRow[]>;
  /** Random songs from the catalog (getRandomSongs pull-forward). */
  randomSongs(size: number, folderId?: string): Promise<SongRow[]>;
  /** All genres with song/album counts (getGenres). */
  listGenres(): Promise<GenreRow[]>;
  /** Songs of one genre (getSongsByGenre). */
  songsByGenre(
    genre: string,
    opts: { size: number; offset: number; folderId?: string },
  ): Promise<SongRow[]>;
  /** Embedded (USLT) lyrics of the best artist/title match (null when the
   * match or the tag is missing). Parsed on demand — no lyrics column. */
  lyrics(query: { artist?: string; title?: string }): Promise<LyricsRow | null>;
  /** Embedded (APIC) cover of an album's first song, or of a song id itself
   * (null when neither resolves or no picture is embedded). */
  embeddedCover(
    id: string,
  ): Promise<{ bytes: Uint8Array; format: string } | null>;
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
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
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
  library_id: string | null;
  library_path: string | null;
  title: string;
  album_id: string | null;
  album_name: string | null;
  artist_id: string | null;
  artist_name: string | null;
  track: number | null;
  disc: number | null;
  duration_ms: number | bigint | null;
  size: number | bigint | null;
  genre: string | null;
  year: number | null;
  is_video: boolean | null;
}

function songOf(row: SongSqlRow): SongRow {
  const suffix = suffixOf(row.path);
  return {
    id: row.id,
    path: row.path,
    libraryId: row.library_id,
    libraryPath: row.library_path,
    title: row.title,
    albumId: row.album_id,
    albumName: row.album_name,
    artistId: row.artist_id,
    artistName: row.artist_name,
    track: num(row.track),
    disc: num(row.disc),
    durationMs: num(row.duration_ms),
    size: num(row.size),
    genre: row.genre,
    year: num(row.year),
    isVideo: row.is_video ?? false,
    suffix,
    contentType: CONTENT_TYPES[suffix] ?? 'application/octet-stream',
  };
}

const SONG_SELECT = `
  SELECT f.id, f.path, f.library_id, l.path AS library_path, f.title,
         f.album_id, al.name AS album_name, f.artist_id,
         ar.name AS artist_name, f.track, f.disc, f.duration_ms, f.size,
         f.genre, f.year, f.is_video
  FROM files f
  LEFT JOIN albums al ON al.id = f.album_id
  LEFT JOIN artists ar ON ar.id = f.artist_id
  LEFT JOIN libraries l ON l.id = f.library_id`;

interface AlbumSqlRow {
  id: string;
  name: string;
  album_artist_id: string;
  artist_name: string;
  song_count: number | bigint;
  duration_ms: number | bigint | null;
  year: number | bigint | null;
  created_ms: number | bigint | null;
}

function albumOf(row: AlbumSqlRow): AlbumRow {
  return {
    id: row.id,
    name: row.name,
    artistId: row.album_artist_id,
    artistName: row.artist_name,
    songCount: Number(row.song_count),
    durationMs: Number(row.duration_ms ?? 0),
    year: num(row.year),
    createdAtMs: num(row.created_ms),
  };
}

// Album query builder. folderId restricts to albums having at least one file
// in that source (musicFolderId); genre restricts to albums with a file of
// that genre; starredBy / ratedBy inner-join the user's stars / ratings;
// listenAgg left-joins per-album play aggregates for frequent / recent. The
// WHERE goes before the GROUP BY, so it composes with callers' HAVING /
// ORDER BY / LIMIT. Stars and ratings join at most one row per album (their
// PKs), and the listen aggregate is one row per album, so song_count and
// duration stay exact.
interface AlbumQuery {
  folderId?: string;
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  starredBy?: string; // users.id
  ratedBy?: string; // users.id
  listenAgg?: string; // users.id
}

function albumSelect(q: AlbumQuery = {}): string {
  const joins: string[] = [];
  if (q.starredBy !== undefined) {
    joins.push(
      `JOIN stars s ON s.target_id = al.id AND s.target_type = 'album'
         AND s.user_id = ${esc(q.starredBy)}`,
    );
  }
  if (q.ratedBy !== undefined) {
    joins.push(
      `JOIN ratings r ON r.target_id = al.id AND r.user_id = ${esc(q.ratedBy)}`,
    );
  }
  if (q.listenAgg !== undefined) {
    joins.push(
      `LEFT JOIN (
         SELECT f2.album_id AS album_id, COUNT(li.track_id) AS play_count,
                MAX(li.played_at) AS last_played
         FROM files f2
         JOIN listens li ON li.track_id = f2.id
           AND li.user_id = ${esc(q.listenAgg)}
         GROUP BY f2.album_id
       ) agg ON agg.album_id = al.id`,
    );
  }
  const wheres: string[] = [];
  if (q.folderId !== undefined) {
    wheres.push(`f.library_id = ${esc(q.folderId)}`);
  }
  if (q.genre !== undefined) wheres.push(`f.genre = ${esc(q.genre)}`);
  if (q.yearFrom !== undefined && q.yearTo !== undefined) {
    wheres.push(`f.year BETWEEN ${q.yearFrom} AND ${q.yearTo}`);
  }
  return `
  SELECT al.id, al.name, al.album_artist_id, ar.name AS artist_name,
         COUNT(f.id) AS song_count, COALESCE(SUM(f.duration_ms), 0) AS duration_ms,
         MAX(f.year) AS year, MAX(f.mtime) AS created_ms
  FROM albums al
  JOIN artists ar ON ar.id = al.album_artist_id
  LEFT JOIN files f ON f.album_id = al.id
  ${joins.join('\n')}
  ${wheres.length === 0 ? '' : `WHERE ${wheres.join(' AND ')}`}
  GROUP BY al.id, al.name, al.album_artist_id, ar.name`;
}

// Artists limited to those with an album that has a file in this source.
function artistFolderFilter(folderId?: string): string {
  return folderId === undefined ? '' : `
   AND EXISTS (
     SELECT 1 FROM albums af JOIN files ff ON ff.album_id = af.id
     WHERE af.album_artist_id = ar.id AND ff.library_id = ${esc(folderId)}
   )`;
}

export function createLibrary(db: Db): Library {
  return {
    async listArtists(folderId): Promise<ArtistRow[]> {
      const res = await db.conn.runAndReadAll(
        `SELECT ar.id, ar.name, COUNT(al.id) AS album_count
         FROM artists ar
         JOIN albums al ON al.album_artist_id = ar.id
         WHERE 1 = 1 ${artistFolderFilter(folderId)}
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
        `${albumSelect()} HAVING al.album_artist_id = ${esc(artistId)}
         ORDER BY al.name`,
      );
      return (res.getRowObjects() as unknown as AlbumSqlRow[]).map(albumOf);
    },

    async listAlbums(opts) {
      const query: AlbumQuery = { folderId: opts.folderId };
      let order: string;
      switch (opts.sort) {
        case 'random':
          order = 'ORDER BY RANDOM()';
          break;
        case 'newest':
          order = 'ORDER BY MAX(f.mtime) DESC NULLS LAST';
          break;
        case 'artist':
          order = 'ORDER BY ar.name, al.name';
          break;
        case 'starred':
        case 'highest':
        case 'frequent':
        case 'recent': {
          if (opts.username === undefined) return [];
          const userId = await userIdForName(db, opts.username);
          if (userId === null) return [];
          if (opts.sort === 'starred') {
            query.starredBy = userId;
            order = 'ORDER BY MAX(s.starred_at) DESC';
          } else if (opts.sort === 'highest') {
            query.ratedBy = userId;
            order = 'ORDER BY MAX(r.rating) DESC, al.name';
          } else {
            query.listenAgg = userId;
            order = opts.sort === 'frequent'
              ? 'ORDER BY MAX(agg.play_count) DESC NULLS LAST, al.name'
              : 'ORDER BY MAX(agg.last_played) DESC NULLS LAST, al.name';
          }
          break;
        }
        case 'genre':
          if (opts.genre === undefined) return [];
          query.genre = opts.genre;
          order = 'ORDER BY al.name';
          break;
        case 'year': {
          if (opts.fromYear === undefined || opts.toYear === undefined) {
            return [];
          }
          query.yearFrom = Math.min(opts.fromYear, opts.toYear);
          query.yearTo = Math.max(opts.fromYear, opts.toYear);
          // Subsonic: fromYear > toYear is a reverse chronological list.
          order = opts.fromYear > opts.toYear
            ? 'ORDER BY MAX(f.year) DESC, al.name'
            : 'ORDER BY MAX(f.year), al.name';
          break;
        }
        default:
          order = 'ORDER BY al.name';
      }
      const res = await db.conn.runAndReadAll(
        `${albumSelect(query)} ${order}
         LIMIT ${opts.size} OFFSET ${opts.offset}`,
      );
      return (res.getRowObjects() as unknown as AlbumSqlRow[]).map(albumOf);
    },

    async getAlbum(id) {
      const albumRes = await db.conn.runAndReadAll(
        `${albumSelect()} HAVING al.id = ${esc(id)}`,
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
           WHERE ar.name ILIKE ${like} ${artistFolderFilter(opts.folderId)}
           GROUP BY ar.id, ar.name
           ORDER BY ar.name
           LIMIT ${opts.artistCount} OFFSET ${opts.artistOffset}`,
        ),
        db.conn.runAndReadAll(
          `${albumSelect({ folderId: opts.folderId })}
           HAVING al.name ILIKE ${like}
           ORDER BY al.name
           LIMIT ${opts.albumCount} OFFSET ${opts.albumOffset}`,
        ),
        db.conn.runAndReadAll(
          `${SONG_SELECT} WHERE f.title ILIKE ${like}${
            opts.folderId === undefined
              ? ''
              : ` AND f.library_id = ${esc(opts.folderId)}`
          }
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

    async videos() {
      const res = await db.conn.runAndReadAll(
        `${SONG_SELECT} WHERE f.is_video ORDER BY f.path`,
      );
      return (res.getRowObjects() as unknown as SongSqlRow[]).map(songOf);
    },

    async randomSongs(size, folderId) {
      const res = await db.conn.runAndReadAll(
        `${SONG_SELECT}${
          folderId === undefined ? '' : ` WHERE f.library_id = ${esc(folderId)}`
        } ORDER BY RANDOM() LIMIT ${Math.trunc(size)}`,
      );
      return (res.getRowObjects() as unknown as SongSqlRow[]).map(songOf);
    },

    async listGenres(): Promise<GenreRow[]> {
      const res = await db.conn.runAndReadAll(
        `SELECT genre, COUNT(*) AS song_count,
                COUNT(DISTINCT album_id) AS album_count
         FROM files
         WHERE genre IS NOT NULL
         GROUP BY genre
         ORDER BY genre`,
      );
      return (res.getRowObjects() as {
        genre: string;
        song_count: number | bigint;
        album_count: number | bigint;
      }[]).map((row) => ({
        name: row.genre,
        songCount: Number(row.song_count),
        albumCount: Number(row.album_count),
      }));
    },

    async songsByGenre(genre, opts) {
      const res = await db.conn.runAndReadAll(
        `${SONG_SELECT}
         WHERE f.genre = ${esc(genre)}${
          opts.folderId === undefined
            ? ''
            : ` AND f.library_id = ${esc(opts.folderId)}`
        }
         ORDER BY f.title
         LIMIT ${opts.size} OFFSET ${opts.offset}`,
      );
      return (res.getRowObjects() as unknown as SongSqlRow[]).map(songOf);
    },

    async lyrics(query) {
      const wheres: string[] = [];
      if (query.artist !== undefined) {
        wheres.push(`ar.name ILIKE ${esc(query.artist)}`);
      }
      if (query.title !== undefined) {
        wheres.push(`f.title ILIKE ${esc(query.title)}`);
      }
      if (wheres.length === 0) return null;
      const res = await db.conn.runAndReadAll(
        `${SONG_SELECT} WHERE ${wheres.join(' AND ')}
         ORDER BY f.title LIMIT 1`,
      );
      const row = (res.getRowObjects() as unknown as SongSqlRow[])[0];
      if (!row) return null;
      const song = songOf(row);
      let text: string | undefined;
      try {
        const meta = await parseFile(song.path);
        text = meta.common.lyrics?.[0]?.text?.trim() || undefined;
      } catch {
        return null; // unreadable file — treated as no lyrics
      }
      if (text === undefined) return null;
      return { artist: song.artistName, title: song.title, text };
    },

    async embeddedCover(id) {
      let res = await db.conn.runAndReadAll(
        `SELECT path FROM files WHERE album_id = ${esc(id)}
         ORDER BY path LIMIT 1`,
      );
      let row = (res.getRowObjects() as { path: string }[])[0];
      if (!row) {
        res = await db.conn.runAndReadAll(
          `SELECT path FROM files WHERE id = ${esc(id)}`,
        );
        row = (res.getRowObjects() as { path: string }[])[0];
      }
      if (!row) return null;
      try {
        const meta = await parseFile(row.path);
        const picture = meta.common.picture?.[0];
        if (!picture) return null;
        return { bytes: picture.data, format: picture.format };
      } catch {
        return null; // unreadable file — treated as no embedded cover
      }
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
