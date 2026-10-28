// Catalog data access. Every public operation owns one exclusive engine slot.
import { atomic, type Engine, esc, type Queries } from './engine.ts';
import { userIdForName } from './users.ts';
import { artistAlbumFolderFilter } from './catalog-sql.ts';
import { isAlbumFolderHint } from '../albums.ts';
import { dirname } from 'node:path';
import { LibraryError, LibrarySourcesChanged } from '../library-errors.ts';
import type { AlbumMetadata, SongMetadata } from '../metadata.ts';
import type { VideoDetails } from '../video.ts';
import type { LyricsSource } from '../lyrics.ts';
import type { LocalVersion } from './candidates.ts';
import type { AlbumInput } from '../albums.ts';
import { covered, type ScanCoverage } from '../scan-scope.ts';
import { type ScanResult, writeScanResult } from './scan.ts';
import { advanceCatalogRevision, catalogRevision } from './catalog-revision.ts';
import {
  albumMetadataColumns,
  metadataSelect,
  songMetadataColumns,
  writeMetadata,
} from './catalog-metadata.ts';
import type {
  Album,
  AlbumEvent,
  AlbumIdentity,
  ArtistKind,
} from '../albums.ts';

export interface ArtistRow {
  id: string;
  name: string;
  musicBrainzId: string | null;
  /** Present when files carry an artist sort tag. */
  sortName?: string;
  albumCount: number;
  /** Present on article-aware or sort-tag lists; the exact ordering/grouping key. */
  sortKey?: string;
}

export interface AlbumRow {
  metadata?: AlbumMetadata;
  id: string;
  name: string | null;
  artistId: string | null;
  artistName: string | null;
  artistKind: ArtistKind;
  folderName: string;
  songCount: number;
  durationMs: number;
  /** Newest song year on the album (null when no song carries a year). */
  year: number | null;
  /** Earliest first-seen time among the album's listed files. */
  createdAtMs: number | null;
}

export interface SongRow {
  pictureHash?: string | null;
  metadata?: SongMetadata;
  id: string;
  path: string;
  /** Source this file was scanned from (null only for pre-M3 rows). */
  libraryId: string | null;
  /** Absolute path of that source's root — hats relativize `path` against it. */
  libraryPath: string | null;
  title: string | null;
  /** Basename without extension; a filesystem fact, never a display label. */
  fileName: string;
  albumId: string | null;
  albumName: string | null;
  albumFolderName: string | null;
  artistId: string | null;
  artistName: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
  size: number | null;
  genre: string | null;
  year: number | null;
  /** Retained first observation, independent of file mtime and retagging. */
  firstSeenMs: number | null;
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

export interface RandomSongOptions {
  size: number;
  folderId?: string;
  genre?: string;
  fromYear?: number;
  toYear?: number;
}

export interface NameSortOptions {
  ignoredArticles?: string[];
  /** Prefer tagged sort names; off unless explicitly requested by the caller. */
  sortTags?: boolean;
}

export interface AlbumPageOptions extends NameSortOptions {
  sort: 'name' | 'artist' | 'year' | 'newest' | 'genre';
  offset: number;
  limit: number;
  folderId?: string;
  genre?: string;
  fromYear?: number;
  toYear?: number;
}

export interface SongPageOptions extends NameSortOptions {
  sort: 'name' | 'artist' | 'year' | 'newest' | 'genre';
  offset: number;
  limit: number;
  folderId?: string;
  genre?: string;
  fromYear?: number;
  toYear?: number;
}

/** Factual groups only: hats own placeholder IDs and labels. */
export type ArtistGroupRef =
  | { kind: 'artist'; id: string }
  | { kind: 'various' | 'unknown' };
export interface ArtistGroupRow {
  kind: 'artist' | 'various' | 'unknown';
  id: string | null;
  name: string | null;
  musicBrainzId: string | null;
  sortName: string | null;
  albumCount: number;
}
export interface ArtistPageOptions extends NameSortOptions {
  folderId?: string;
  offset: number;
  limit: number;
}

export interface CatalogReads {
  artistsPage(opts: ArtistPageOptions): Promise<{
    rows: ArtistGroupRow[];
    total: number;
    revision: string;
  }>;
  getArtistSnapshot(ref: ArtistGroupRef, folderId?: string): Promise<{
    artist: ArtistGroupRow | null;
    revision: string;
  }>;
  artistAlbumsPage(ref: ArtistGroupRef, opts: ArtistPageOptions): Promise<{
    artist: ArtistGroupRow | null;
    rows: AlbumRow[];
    total: number;
    revision: string;
  }>;
  /** Album artists (artists with at least one album), alphabetically. */
  listArtists(
    folderId?: string,
    opts?: NameSortOptions,
  ): Promise<ArtistRow[]>;
  /** One album artist by ID (null when unknown or has no albums). */
  getArtist(id: string): Promise<ArtistRow | null>;
  /** Any catalog artist, including track-only performers with zero albums. */
  artistById(id: string): Promise<ArtistRow | null>;
  /** Every present artist, including track-only performers, scoped to a library. */
  artistIds(folderId?: string): Promise<string[]>;
  /** Albums of one album artist, alphabetically. */
  albumsByArtist(artistId: string, opts?: NameSortOptions): Promise<AlbumRow[]>;
  albumsWithoutArtist(
    kind: 'various' | 'unknown',
    opts?: NameSortOptions & { folderId?: string },
  ): Promise<AlbumRow[]>;
  /** Album lists for getAlbumList/getAlbumList2-shaped hats. The user-scoped
   * sorts (highest / frequent / recent) need `username`; `genre` sort needs
   * `genre`. Favourites are not a sort here: hats derive their order from
   * app.annotation's star history and resolve rows with albumsById. */
  listAlbums(
    opts: NameSortOptions & {
      sort:
        | 'name'
        | 'artist'
        | 'random'
        | 'newest'
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
    },
  ): Promise<AlbumRow[]>;
  /** The given albums (unknown ids skipped), by id. With `folderId`, only
   * albums with a file in that source, counted and timed within it exactly
   * as listAlbums scopes them. */
  albumsById(ids: string[], opts: { folderId?: string }): Promise<AlbumRow[]>;
  getAlbum(id: string): Promise<{ album: AlbumRow; songs: SongRow[] } | null>;
  /** Bounded common catalog facts, exact pre-page total and revision in one slot. */
  albumsPage(opts: AlbumPageOptions): Promise<{
    rows: AlbumRow[];
    total: number;
    revision: string;
  }>;
  getAlbumSnapshot(id: string, folderId?: string): Promise<{
    detail: { album: AlbumRow; songs: SongRow[] } | null;
    revision: string;
  }>;
  getSong(id: string): Promise<SongRow | null>;
  /** Facts and their persistent revision, read under one exclusive slot. */
  getSongSnapshot(
    id: string,
  ): Promise<{ song: SongRow | null; revision: string }>;
  /** Bounded eligible songs, exact pre-page total and revision in one slot. */
  songsPage(opts: SongPageOptions): Promise<{
    rows: SongRow[];
    total: number;
    revision: string;
  }>;
  search3(
    query: string,
    opts: NameSortOptions & {
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
  videos(folderId?: string): Promise<SongRow[]>;
  videoDetails(id: string): Promise<VideoDetails | null>;
  /** Random songs from the catalog (getRandomSongs pull-forward). */
  randomSongs(opts: RandomSongOptions): Promise<SongRow[]>;
  randomSongs(size: number, folderId?: string): Promise<SongRow[]>;
  /** Paged catalog walk in a STABLE order (path) — for deterministic
   * wire-id resolution (OwnTone find-by-wire-int). */
  listSongs(opts: { offset: number; size: number }): Promise<SongRow[]>;
  /** All genres with song/album counts (getGenres). */
  listGenres(): Promise<GenreRow[]>;
  /** Songs of one genre (getSongsByGenre). */
  songsByGenre(
    genre: string,
    opts: NameSortOptions & { size: number; offset: number; folderId?: string },
  ): Promise<SongRow[]>;
  songsForLyrics(
    query: { artist?: string; title?: string },
    limit: number,
  ): Promise<SongRow[]>;
  songForLyrics(
    query: { artist?: string; title?: string },
  ): Promise<SongRow | null>;
  coverSongPath(id: string): Promise<string | null>;
  albumSongPath(id: string): Promise<string | null>;
  /** Track directories first, then an eligible album-only root directory. */
  albumCoverDirectories(id: string): Promise<string[]>;
  /** Exclusive parent of every album directory, within exactly one library. */
  artistFolder(
    id: string,
  ): Promise<{ directory: string; libraryId: string } | null>;
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

// Generic sorting policy: the hat supplies articles, core owns the computed
// key. Strip a single case-sensitive leading article after accent folding,
// before lowercasing (Navidrome); unoptioned callers retain their old order.
function sortKeySql(column: string, articles?: string[], tag?: string): string {
  if (tag !== undefined) {
    // A sort tag is already in sort form: fold like the fallback, but never
    // strip an article from it. Empty tags have the same fallback as absent tags.
    return `CASE WHEN nullif(trim(${tag}), '') IS NOT NULL THEN ${
      sortKeySql(tag, articles === undefined ? undefined : [])
    } ELSE ${sortKeySql(column, articles)} END`;
  }
  if (articles === undefined) return column;
  const folded = `trim(strip_accents(${column}))`;
  const branches = articles.map((article) =>
    `WHEN starts_with(${folded}, ${
      esc(article + ' ')
    }) THEN substring(${folded}, length(${esc(article)}) + 2)`
  );
  const stripped = branches.length === 0
    ? folded
    : `CASE ${branches.join(' ')} ELSE ${folded} END`;
  return `lower(trim(${stripped}))`;
}

interface SongSqlRow {
  picture_hash: string | null;
  metadata_json: string | null;
  id: string;
  path: string;
  library_id: string | null;
  library_path: string | null;
  title: string | null;
  file_name: string;
  album_id: string | null;
  album_name: string | null;
  album_folder_name: string | null;
  artist_id: string | null;
  artist_name: string | null;
  track: number | null;
  disc: number | null;
  duration_ms: number | bigint | null;
  size: number | bigint | null;
  genre: string | null;
  year: number | null;
  first_seen_ms: number | bigint | null;
  is_video: boolean | null;
}

function songOf(row: SongSqlRow): SongRow {
  const suffix = suffixOf(row.path);
  return {
    id: row.id,
    path: row.path,
    pictureHash: row.picture_hash,
    ...(row.metadata_json === null
      ? {}
      : { metadata: JSON.parse(row.metadata_json) }),
    libraryId: row.library_id,
    libraryPath: row.library_path,
    title: row.title,
    fileName: row.file_name,
    albumId: row.album_id,
    albumName: row.album_name,
    albumFolderName: row.album_folder_name,
    artistId: row.artist_id,
    artistName: row.artist_name,
    track: num(row.track),
    disc: num(row.disc),
    durationMs: num(row.duration_ms),
    size: num(row.size),
    genre: row.genre,
    year: num(row.year),
    firstSeenMs: num(row.first_seen_ms),
    isVideo: row.is_video ?? false,
    suffix,
    contentType: CONTENT_TYPES[suffix] ?? 'application/octet-stream',
  };
}

const SONG_FILE_NAME =
  `regexp_replace(regexp_extract(f.path, '[^/]+$'), '\\.[^.]*$', '')`;
const SONG_TITLE = `COALESCE(f.title, ${SONG_FILE_NAME})`;
const SONG_SELECT = `
  SELECT f.id, f.path, f.library_id, l.path AS library_path, f.title, ${SONG_FILE_NAME} AS file_name,
         f.album_id, al.name AS album_name, al.folder_name AS album_folder_name, f.artist_id,
         ar.name AS artist_name, f.track, f.disc, f.duration_ms, f.size,
         f.genre, f.year, f.is_video, f.picture_hash, epoch_ms(fi.first_seen_at) AS first_seen_ms,
         ${metadataSelect(songMetadataColumns, 'f')}
  FROM files f
  LEFT JOIN albums al ON al.id = f.album_id
  LEFT JOIN artists ar ON ar.id = f.artist_id
  LEFT JOIN libraries l ON l.id = f.library_id
  LEFT JOIN file_identity fi ON fi.id = f.id`;

interface AlbumSqlRow {
  metadata_json: string | null;
  id: string;
  name: string | null;
  album_artist_id: string | null;
  artist_name: string | null;
  artist_kind: ArtistKind;
  folder_name: string;
  song_count: number | bigint;
  duration_ms: number | bigint | null;
  year: number | bigint | null;
  created_ms: number | bigint | null;
}

function albumOf(row: AlbumSqlRow): AlbumRow {
  return {
    ...(row.metadata_json === null
      ? {}
      : { metadata: JSON.parse(row.metadata_json) }),
    id: row.id,
    name: row.name,
    artistId: row.album_artist_id,
    artistName: row.artist_name,
    artistKind: row.artist_kind,
    folderName: row.folder_name,
    songCount: Number(row.song_count),
    durationMs: Number(row.duration_ms ?? 0),
    year: num(row.year),
    createdAtMs: num(row.created_ms),
  };
}

// Album query builder. folderId restricts to albums having at least one file
// in that source (musicFolderId); genre restricts to albums with a file of
// that genre; ratedBy inner-joins the user's ratings; listenAgg inner-joins
// per-album play aggregates for frequent / recent. The WHERE goes before the
// GROUP BY, so it composes with callers' HAVING / ORDER BY / LIMIT. Ratings
// join at most one row per album (their PK), and the listen aggregate is one
// row per album, so song_count and duration stay exact.
interface AlbumQuery {
  folderId?: string;
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  ratedBy?: string; // users.id
  listenAgg?: string; // users.id
}

function albumSelect(q: AlbumQuery = {}): string {
  const joins: string[] = [];
  if (q.ratedBy !== undefined) {
    joins.push(
      `JOIN ratings r ON r.target_id = al.id AND r.user_id = ${esc(q.ratedBy)}`,
    );
  }
  if (q.listenAgg !== undefined) {
    joins.push(
      `JOIN (
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
  if (q.genre !== undefined) {
    wheres.push(
      `EXISTS (SELECT 1 FROM files fg WHERE fg.album_id = al.id AND fg.genre = ${
        esc(q.genre)
      })`,
    );
  }
  if (q.yearFrom !== undefined || q.yearTo !== undefined) {
    const years = [
      ...(q.yearFrom === undefined ? [] : [`fy.year >= ${q.yearFrom}`]),
      ...(q.yearTo === undefined ? [] : [`fy.year <= ${q.yearTo}`]),
    ];
    wheres.push(
      `EXISTS (SELECT 1 FROM files fy WHERE fy.album_id = al.id AND ${
        years.join(' AND ')
      })`,
    );
  }
  return `
  SELECT al.id, al.name, al.album_artist_id, al.artist_kind, al.folder_name, ar.name AS artist_name,
         COUNT(f.id) AS song_count, COALESCE(SUM(f.duration_ms), 0) AS duration_ms,
          MAX(f.year) AS year, epoch_ms(MIN(fi.first_seen_at)) AS created_ms,
          ${metadataSelect(albumMetadataColumns, 'al', true)}
  FROM albums al
  LEFT JOIN artists ar ON ar.id = al.album_artist_id
  LEFT JOIN files f ON f.album_id = al.id
  LEFT JOIN file_identity fi ON fi.id = f.id
  ${joins.join('\n')}
  ${wheres.length === 0 ? '' : `WHERE ${wheres.join(' AND ')}`}
  GROUP BY al.id, al.name, al.album_artist_id, al.artist_kind, al.folder_name, ar.name`;
}

// File eligibility has one owner for sync, browse pages and random sampling.
// Optional bounds are inclusive; SQL NULL comparisons do not invent a year.
function songPredicates(opts: Omit<RandomSongOptions, 'size'>): string[] {
  const predicates: string[] = [];
  if (opts.folderId !== undefined) {
    predicates.push(`f.library_id = ${esc(opts.folderId)}`);
  }
  if (opts.genre !== undefined) predicates.push(`f.genre = ${esc(opts.genre)}`);
  if (opts.fromYear !== undefined) {
    predicates.push(`f.year >= ${opts.fromYear}`);
  }
  if (opts.toYear !== undefined) predicates.push(`f.year <= ${opts.toYear}`);
  return predicates;
}

interface ArtistGroupSqlRow {
  kind: ArtistGroupRow['kind'];
  id: string | null;
  name: string | null;
  musicbrainz_id: string | null;
  sort_name: string | null;
  album_count: bigint;
}

function artistGroupOf(row: ArtistGroupSqlRow): ArtistGroupRow {
  return {
    kind: row.kind,
    id: row.id,
    name: row.name,
    musicBrainzId: row.musicbrainz_id,
    sortName: row.sort_name,
    albumCount: Number(row.album_count),
  };
}

// Both root groups and details use the same scoped album population. Details
// additionally admit a performer present only on tracks, with zero memberships.
function artistGroups(folderId?: string, trackOnly = false): string {
  const scope = folderId === undefined
    ? ''
    : `AND f.library_id = ${esc(folderId)}`;
  return `WITH eligible_albums AS (
    SELECT al.* FROM albums al WHERE EXISTS (
      SELECT 1 FROM files f WHERE f.album_id = al.id ${scope})
  )
  SELECT 'artist' AS kind, ar.id, ar.name, ar.musicbrainz_id,
    first(ar.sort_name) AS sort_name, COUNT(al.id) AS album_count
  FROM artists ar ${trackOnly ? 'LEFT JOIN' : 'JOIN'} eligible_albums al
    ON al.album_artist_id = ar.id
  ${
    trackOnly
      ? `WHERE EXISTS (
    SELECT 1 FROM files f LEFT JOIN albums a ON a.id = f.album_id
    WHERE (f.artist_id = ar.id OR a.album_artist_id = ar.id) ${scope})`
      : ''
  }
  GROUP BY ar.id, ar.name, ar.musicbrainz_id
  UNION ALL
  SELECT artist_kind AS kind, NULL AS id, NULL AS name,
    NULL AS musicbrainz_id, NULL AS sort_name, COUNT(*) AS album_count
  FROM eligible_albums WHERE album_artist_id IS NULL
    AND artist_kind IN ('various', 'unknown') GROUP BY artist_kind`;
}

function artistGroupPredicate(ref: ArtistGroupRef): string {
  return ref.kind === 'artist'
    ? `kind = 'artist' AND id = ${esc(ref.id)}`
    : `kind = ${esc(ref.kind)}`;
}

// Internal helpers share the current slot, never another public operation.
function catalogReads(q: Queries): CatalogReads {
  async function requireLibrary(folderId?: string) {
    if (folderId === undefined) return;
    const rows = await q.all(
      `SELECT id FROM libraries WHERE id = ${esc(folderId)}`,
    );
    if (rows.length === 0) {
      throw new LibraryError('not_found', 'Library not found');
    }
  }

  async function albumDetail(id: string, folderId?: string) {
    const albumRes = await q.all(
      `${albumSelect({ folderId })} HAVING al.id = ${esc(id)}`,
    );
    const albumRow = (albumRes as unknown as AlbumSqlRow[])[0];
    if (!albumRow) return null;
    const songRes = await q.all(
      `${SONG_SELECT} WHERE f.album_id = ${esc(id)}${
        folderId === undefined ? '' : ` AND f.library_id = ${esc(folderId)}`
      } ORDER BY f.disc, f.track, f.path, f.id`,
    );
    return {
      album: albumOf(albumRow),
      songs: (songRes as unknown as SongSqlRow[]).map(songOf),
    };
  }

  async function artistGroup(ref: ArtistGroupRef, folderId?: string) {
    const rows = await q.all<ArtistGroupSqlRow>(
      `SELECT * FROM (${artistGroups(folderId, true)}) groups
        WHERE ${artistGroupPredicate(ref)}`,
    );
    return rows[0] ? artistGroupOf(rows[0]) : null;
  }

  async function resolveArtist(
    id: string,
    all: boolean,
  ): Promise<ArtistRow | null> {
    const res = await q.all(
      `SELECT ar.id, ar.name, ar.musicbrainz_id, first(ar.sort_name) AS sort_name, COUNT(al.id) AS album_count
       FROM artists ar
       ${all ? 'LEFT JOIN' : 'JOIN'} albums al ON al.album_artist_id = ar.id
       WHERE ar.id = ${esc(id)}
       GROUP BY ar.id, ar.name, ar.musicbrainz_id`,
    );
    const row = (res as {
      id: string;
      name: string;
      musicbrainz_id: string | null;
      sort_name: string | null;
      album_count: number | bigint;
    }[])[0];
    return row
      ? {
        id: row.id,
        name: row.name,
        musicBrainzId: row.musicbrainz_id,
        ...(row.sort_name === null ? {} : { sortName: row.sort_name }),
        albumCount: Number(row.album_count),
      }
      : null;
  }
  return {
    async artistsPage(opts) {
      await requireLibrary(opts.folderId);
      const select = artistGroups(opts.folderId);
      const count = await q.all<{ total: bigint }>(
        `SELECT COUNT(*) AS total FROM (${select}) groups`,
      );
      const key = sortKeySql(
        'name',
        opts.ignoredArticles,
        opts.sortTags ? 'sort_name' : undefined,
      );
      const rows = await q.all<ArtistGroupSqlRow>(
        `SELECT * FROM (${select}) groups ORDER BY ${key} NULLS LAST,
          kind, id LIMIT ${opts.limit} OFFSET ${opts.offset}`,
      );
      return {
        rows: rows.map(artistGroupOf),
        total: Number(count[0].total),
        revision: await catalogRevision(q),
      };
    },

    async getArtistSnapshot(ref, folderId) {
      await requireLibrary(folderId);
      return {
        artist: await artistGroup(ref, folderId),
        revision: await catalogRevision(q),
      };
    },

    async artistAlbumsPage(ref, opts) {
      await requireLibrary(opts.folderId);
      const artist = await artistGroup(ref, opts.folderId);
      const membership = ref.kind === 'artist'
        ? `al.album_artist_id = ${esc(ref.id)}`
        : `al.album_artist_id IS NULL AND al.artist_kind = ${esc(ref.kind)}`;
      const key = sortKeySql(
        'COALESCE(al.name, al.folder_name)',
        opts.ignoredArticles,
        opts.sortTags ? 'first(al.sort_name)' : undefined,
      );
      const rows = artist === null ? [] : await q.all<AlbumSqlRow>(
        `${albumSelect({ folderId: opts.folderId })} HAVING ${membership}
          ORDER BY ${key}, al.id LIMIT ${opts.limit} OFFSET ${opts.offset}`,
      );
      return {
        artist,
        rows: rows.map(albumOf),
        total: artist?.albumCount ?? 0,
        revision: await catalogRevision(q),
      };
    },

    async listArtists(folderId, opts = {}): Promise<ArtistRow[]> {
      const key = sortKeySql(
        'ar.name',
        opts.ignoredArticles,
        opts.sortTags ? 'first(ar.sort_name)' : undefined,
      );
      const res = await q.all(
        `SELECT ar.id, ar.name, ar.musicbrainz_id, first(ar.sort_name) AS sort_name, COUNT(al.id) AS album_count, ${key} AS sort_key
         FROM artists ar
         JOIN albums al ON al.album_artist_id = ar.id
         WHERE 1 = 1 ${artistAlbumFolderFilter(folderId)}
         GROUP BY ar.id, ar.name, ar.musicbrainz_id
          ORDER BY sort_key, ar.id`,
      );
      return (res as {
        id: string;
        name: string;
        musicbrainz_id: string | null;
        sort_name: string | null;
        album_count: number | bigint;
        sort_key: string;
      }[]).map((row) => ({
        id: row.id,
        name: row.name,
        musicBrainzId: row.musicbrainz_id,
        ...(row.sort_name === null ? {} : { sortName: row.sort_name }),
        albumCount: Number(row.album_count),
        ...(opts.ignoredArticles === undefined && !opts.sortTags
          ? {}
          : { sortKey: row.sort_key }),
      }));
    },

    async getArtist(id) {
      return await resolveArtist(id, false);
    },

    async artistById(id) {
      return await resolveArtist(id, true);
    },
    async artistIds(folderId) {
      return (await q.all<{ id: string }>(`SELECT ar.id FROM artists ar
        WHERE EXISTS (SELECT 1 FROM files f LEFT JOIN albums al ON al.id = f.album_id
          WHERE (f.artist_id = ar.id OR al.album_artist_id = ar.id)
          ${
        folderId === undefined ? '' : `AND f.library_id = ${esc(folderId)}`
      }) ORDER BY ar.id`)).map((row) => row.id);
    },

    async albumsByArtist(artistId, opts = {}) {
      const res = await q.all(
        `${albumSelect()} HAVING al.album_artist_id = ${esc(artistId)}
         ORDER BY ${
          sortKeySql(
            'COALESCE(al.name, al.folder_name)',
            opts.ignoredArticles,
            opts.sortTags ? 'first(al.sort_name)' : undefined,
          )
        }, al.id`,
      );
      return (res as unknown as AlbumSqlRow[]).map(albumOf);
    },

    async albumsWithoutArtist(kind, opts = {}) {
      const res = await q.all(`${albumSelect({ folderId: opts.folderId })}
        HAVING al.album_artist_id IS NULL AND al.artist_kind = ${esc(kind)}
        ORDER BY ${
        sortKeySql(
          'COALESCE(al.name, al.folder_name)',
          opts.ignoredArticles,
          opts.sortTags ? 'first(al.sort_name)' : undefined,
        )
      }, al.id`);
      return (res as unknown as AlbumSqlRow[]).map(albumOf);
    },

    async listAlbums(opts) {
      const query: AlbumQuery = { folderId: opts.folderId };
      const albumKey = sortKeySql(
        'COALESCE(al.name, al.folder_name)',
        opts.ignoredArticles,
        opts.sortTags ? 'first(al.sort_name)' : undefined,
      );
      // These modes historically used a raw name as their secondary key, even
      // when callers supplied articles. Keep that contract with sort tags off.
      const secondaryKey = opts.sortTags
        ? albumKey
        : 'COALESCE(al.name, al.folder_name)';
      let order: string;
      switch (opts.sort) {
        case 'random':
          order = 'ORDER BY RANDOM()';
          break;
        case 'newest':
          order = 'ORDER BY created_ms DESC NULLS LAST';
          break;
        case 'artist':
          order = `ORDER BY ${
            sortKeySql(
              'ar.name',
              opts.ignoredArticles,
              opts.sortTags ? 'first(ar.sort_name)' : undefined,
            )
          }, ${albumKey}`;
          break;
        case 'highest':
        case 'frequent':
        case 'recent': {
          if (opts.username === undefined) return [];
          const userId = await userIdForName(q, opts.username);
          if (userId === null) return [];
          if (opts.sort === 'highest') {
            query.ratedBy = userId;
            order = `ORDER BY MAX(r.rating) DESC, ${secondaryKey}`;
          } else {
            query.listenAgg = userId;
            order = opts.sort === 'frequent'
              ? `ORDER BY MAX(agg.play_count) DESC NULLS LAST, ${secondaryKey}`
              : `ORDER BY MAX(agg.last_played) DESC NULLS LAST, ${secondaryKey}`;
          }
          break;
        }
        case 'genre':
          if (opts.genre === undefined) return [];
          query.genre = opts.genre;
          order = `ORDER BY ${secondaryKey}`;
          break;
        case 'year': {
          if (opts.fromYear === undefined || opts.toYear === undefined) {
            return [];
          }
          query.yearFrom = Math.min(opts.fromYear, opts.toYear);
          query.yearTo = Math.max(opts.fromYear, opts.toYear);
          // Subsonic: fromYear > toYear is a reverse chronological list.
          order = opts.fromYear > opts.toYear
            ? `ORDER BY MAX(f.year) DESC, ${secondaryKey}`
            : `ORDER BY MAX(f.year), ${secondaryKey}`;
          break;
        }
        default:
          order = `ORDER BY ${albumKey}`;
      }
      const res = await q.all(
        `${albumSelect(query)} ${order}${
          opts.sort === 'random' ? '' : ', al.id'
        }
         LIMIT ${opts.size} OFFSET ${opts.offset}`,
      );
      return (res as unknown as AlbumSqlRow[]).map(albumOf);
    },

    async albumsById(ids, opts) {
      if (ids.length === 0) return [];
      const res = await q.all(
        `${albumSelect({ folderId: opts.folderId })}
         HAVING al.id IN (${[...new Set(ids)].map(esc).join(', ')})
         ORDER BY al.id`,
      );
      return (res as unknown as AlbumSqlRow[]).map(albumOf);
    },

    getAlbum: (id) => albumDetail(id),

    async albumsPage(opts) {
      await requireLibrary(opts.folderId);
      const select = albumSelect({
        folderId: opts.folderId,
        genre: opts.genre,
        yearFrom: opts.fromYear,
        yearTo: opts.toYear,
      });
      const name = sortKeySql(
        'COALESCE(al.name, al.folder_name)',
        opts.ignoredArticles,
        opts.sortTags ? 'first(al.sort_name)' : undefined,
      );
      let order: string;
      switch (opts.sort) {
        case 'newest':
          order = 'created_ms DESC NULLS LAST';
          break;
        case 'year':
          order = `MAX(f.year) NULLS LAST, ${name}`;
          break;
        case 'artist':
          order = `${
            sortKeySql(
              'ar.name',
              opts.ignoredArticles,
              opts.sortTags ? 'first(ar.sort_name)' : undefined,
            )
          } NULLS LAST, ${name}`;
          break;
        default:
          order = name;
      }
      const count = await q.all<{ total: bigint }>(
        `SELECT COUNT(*) AS total FROM (${select}) eligible`,
      );
      const rows = await q.all<AlbumSqlRow>(
        `${select} ORDER BY ${order}, al.id LIMIT ${opts.limit} OFFSET ${opts.offset}`,
      );
      return {
        rows: rows.map(albumOf),
        total: Number(count[0].total),
        revision: await catalogRevision(q),
      };
    },

    async getAlbumSnapshot(id, folderId) {
      await requireLibrary(folderId);
      return {
        detail: await albumDetail(id, folderId),
        revision: await catalogRevision(q),
      };
    },

    async getSong(id) {
      const res = await q.all(
        `${SONG_SELECT} WHERE f.id = ${esc(id)}`,
      );
      const row = (res as unknown as SongSqlRow[])[0];
      return row ? songOf(row) : null;
    },

    async getSongSnapshot(id) {
      return {
        song: await catalogReads(q).getSong(id),
        revision: await catalogRevision(q),
      };
    },

    async songsPage(opts) {
      await requireLibrary(opts.folderId);
      const predicates = songPredicates(opts);
      const where = predicates.length === 0
        ? ''
        : ` WHERE ${predicates.join(' AND ')}`;
      const name = sortKeySql(
        SONG_TITLE,
        opts.ignoredArticles,
        opts.sortTags ? 'f.sort_title' : undefined,
      );
      let order: string;
      switch (opts.sort) {
        case 'newest':
          order = 'fi.first_seen_at DESC NULLS LAST';
          break;
        case 'year':
          order = `f.year NULLS LAST, ${name}`;
          break;
        case 'artist':
          order = `${
            sortKeySql(
              'ar.name',
              opts.ignoredArticles,
              opts.sortTags ? 'f.artist_sort_name' : undefined,
            )
          } NULLS LAST, ${name}`;
          break;
        default:
          order = name;
      }
      const count = await q.all<{ total: bigint }>(
        `SELECT COUNT(*) AS total FROM files f${where}`,
      );
      const rows = await q.all<SongSqlRow>(
        `${SONG_SELECT}${where} ORDER BY ${order}, f.id LIMIT ${opts.limit} OFFSET ${opts.offset}`,
      );
      return {
        rows: rows.map(songOf),
        total: Number(count[0].total),
        revision: await catalogRevision(q),
      };
    },

    async search3(query, opts) {
      const like = `'%' || ${esc(query)} || '%'`;
      const artistRes = await q.all(
        `SELECT ar.id, ar.name, ar.musicbrainz_id, first(ar.sort_name) AS sort_name, COUNT(al.id) AS album_count
           FROM artists ar
           JOIN albums al ON al.album_artist_id = ar.id
           WHERE ar.name ILIKE ${like} ${artistAlbumFolderFilter(opts.folderId)}
           GROUP BY ar.id, ar.name, ar.musicbrainz_id
             ORDER BY ${
          sortKeySql(
            'ar.name',
            opts.ignoredArticles,
            opts.sortTags ? 'first(ar.sort_name)' : undefined,
          )
        }, ar.id
           LIMIT ${opts.artistCount} OFFSET ${opts.artistOffset}`,
      );
      const albumRes = await q.all(
        `${albumSelect({ folderId: opts.folderId })}
            HAVING COALESCE(al.name, al.folder_name) ILIKE ${like}
              ORDER BY ${
          sortKeySql(
            'COALESCE(al.name, al.folder_name)',
            opts.ignoredArticles,
            opts.sortTags ? 'first(al.sort_name)' : undefined,
          )
        }, al.id
           LIMIT ${opts.albumCount} OFFSET ${opts.albumOffset}`,
      );
      const songRes = await q.all(
        `${SONG_SELECT} WHERE ${
          [`${SONG_TITLE} ILIKE ${like}`, ...songPredicates(opts)].join(' AND ')
        }
             ORDER BY ${
          sortKeySql(
            SONG_TITLE,
            opts.ignoredArticles,
            opts.sortTags ? 'f.sort_title' : undefined,
          )
        }, f.id
           LIMIT ${opts.songCount} OFFSET ${opts.songOffset}`,
      );
      return {
        artists: (artistRes as {
          id: string;
          name: string;
          musicbrainz_id: string | null;
          sort_name: string | null;
          album_count: number | bigint;
        }[]).map((row) => ({
          id: row.id,
          name: row.name,
          musicBrainzId: row.musicbrainz_id,
          ...(row.sort_name === null ? {} : { sortName: row.sort_name }),
          albumCount: Number(row.album_count),
        })),
        albums: (albumRes as unknown as AlbumSqlRow[]).map(
          albumOf,
        ),
        songs: (songRes as unknown as SongSqlRow[]).map(songOf),
      };
    },

    async songPath(id) {
      const res = await q.all(
        `SELECT path FROM files WHERE id = ${esc(id)}`,
      );
      const row = (res as { path: string }[])[0];
      return row?.path ?? null;
    },

    async videoDetails(id) {
      const rows = await q.all(
        `SELECT video_details::VARCHAR AS details FROM files WHERE id = ${
          esc(id)
        } AND is_video`,
      );
      const row = (rows as { details: string | null }[])[0];
      return row?.details ? JSON.parse(row.details) : null;
    },

    async videos(folderId) {
      const res = await q.all(
        `${SONG_SELECT} WHERE f.is_video${
          folderId === undefined ? '' : ` AND f.library_id = ${esc(folderId)}`
        } ORDER BY f.path`,
      );
      return (res as unknown as SongSqlRow[]).map(songOf);
    },

    async randomSongs(input: RandomSongOptions | number, folderId?: string) {
      const opts = typeof input === 'number'
        ? { size: input, folderId }
        : input;
      const predicates = songPredicates(opts);
      const res = await q.all(
        `${SONG_SELECT}${
          predicates.length === 0 ? '' : ` WHERE ${predicates.join(' AND ')}`
        } ORDER BY RANDOM() LIMIT ${Math.trunc(opts.size)}`,
      );
      return (res as unknown as SongSqlRow[]).map(songOf);
    },

    async listSongs(opts) {
      const res = await q.all(
        `${SONG_SELECT} ORDER BY f.path, f.id
         LIMIT ${Math.trunc(opts.size)} OFFSET ${Math.trunc(opts.offset)}`,
      );
      return (res as unknown as SongSqlRow[]).map(songOf);
    },

    async listGenres(): Promise<GenreRow[]> {
      const res = await q.all(
        `SELECT genre, COUNT(*) AS song_count,
                COUNT(DISTINCT album_id) AS album_count
         FROM files
         WHERE genre IS NOT NULL
         GROUP BY genre
         ORDER BY genre`,
      );
      return (res as {
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
      const res = await q.all(
        `${SONG_SELECT}
         WHERE ${songPredicates({ ...opts, genre }).join(' AND ')}
          ORDER BY ${
          sortKeySql(
            SONG_TITLE,
            opts.ignoredArticles,
            opts.sortTags ? 'f.sort_title' : undefined,
          )
        }, f.id
         LIMIT ${opts.size} OFFSET ${opts.offset}`,
      );
      return (res as unknown as SongSqlRow[]).map(songOf);
    },

    async songsForLyrics(query, limit) {
      const wheres: string[] = [];
      if (query.artist !== undefined) {
        wheres.push(
          `(lower(ar.name) = lower(${
            esc(query.artist)
          }) OR EXISTS (SELECT 1 FROM artists aa WHERE aa.id = al.album_artist_id AND lower(aa.name) = lower(${
            esc(query.artist)
          })))`,
        );
      }
      if (query.title !== undefined) {
        // Equality treats % and _ literally: there is no SQL pattern to escape.
        wheres.push(`lower(f.title) = lower(${esc(query.title)})`);
      }
      if (wheres.length === 0) return [];
      const res = await q.all(
        `${SONG_SELECT} WHERE ${wheres.join(' AND ')}
         ORDER BY f.has_lyrics DESC, f.mtime DESC NULLS LAST, f.id LIMIT ${
          Math.max(0, Math.trunc(limit))
        }`,
      );
      return (res as unknown as SongSqlRow[]).map(songOf);
    },

    async songForLyrics(query) {
      return (await this.songsForLyrics(query, 1))[0] ?? null;
    },

    async coverSongPath(id) {
      let res = await q.all(
        `SELECT path FROM files WHERE album_id = ${esc(id)}
         ORDER BY disc, track, path, id LIMIT 1`,
      );
      let row = (res as { path: string }[])[0];
      if (!row) {
        res = await q.all(
          `SELECT path FROM files WHERE id = ${esc(id)}`,
        );
        row = (res as { path: string }[])[0];
      }
      return row?.path ?? null;
    },

    async albumSongPath(id) {
      const res = await q.all(
        `SELECT path FROM files WHERE album_id = ${
          esc(id)
        } ORDER BY path LIMIT 1`,
      );
      const row = (res as { path: string }[])[0];
      return row?.path ?? null;
    },

    async artistFolder(id) {
      const rows = await q.all<
        {
          root: string;
          libraryId: string;
          artistId: string | null;
          libraryPath: string;
        }
      >(
        `SELECT al.root_dir AS root, al.library_id AS libraryId,
          al.album_artist_id AS artistId, l.path AS libraryPath
         FROM albums al JOIN libraries l ON l.id = al.library_id`,
      );
      const own = rows.filter((row) => row.artistId === id);
      if (!own.length || new Set(own.map((row) => row.libraryId)).size !== 1) {
        return null;
      }
      const root = own[0].libraryPath.replace(/\/+$/, '');
      // An artist holds albums: never mistake the album's own directory for
      // its artist folder, including when the artist has only one album.
      let directory = dirname(`${root}/${own[0].root}`);
      for (const row of own.slice(1)) {
        const parent = dirname(`${root}/${row.root}`);
        while (parent !== directory && !parent.startsWith(`${directory}/`)) {
          const next = dirname(directory);
          if (next === directory) return null;
          directory = next;
        }
      }
      if (directory === root || !directory.startsWith(`${root}/`)) return null;
      if (
        rows.some((row) =>
          row.libraryId === own[0].libraryId && row.artistId !== id &&
          (`${root}/${row.root}` === directory ||
            `${root}/${row.root}`.startsWith(`${directory}/`))
        )
      ) return null;
      return { directory, libraryId: own[0].libraryId };
    },
    async albumCoverDirectories(id) {
      const rows = await q.all<{
        dir: string;
        library_path: string;
        root_dir: string;
      }>(`SELECT DISTINCT regexp_replace(f.path, '/[^/]+$', '') AS dir,
                 l.path AS library_path, al.root_dir
          FROM albums al JOIN files f ON f.album_id = al.id
          JOIN libraries l ON l.id = al.library_id
          WHERE al.id = ${esc(id)} ORDER BY dir`);
      if (rows.length === 0) return [];
      const dirs = rows.map((r) => r.dir);
      const libraryPath = rows[0].library_path.replace(/\/+$/, '');
      const root = rows[0].root_dir;
      const albumDir = root === '' ? libraryPath : `${libraryPath}/${root}`;
      const merged = dirs.length > 1;
      if (
        !merged &&
        !isAlbumFolderHint(albumDir.slice(albumDir.lastIndexOf('/') + 1))
      ) {
        return dirs;
      }
      const candidate = merged
        ? albumDir
        : albumDir.slice(0, albumDir.lastIndexOf('/'));
      // A root fallback must belong solely to this album, never the library
      // root or an artist folder containing any other album's media.
      if (
        candidate === libraryPath || !candidate.startsWith(`${libraryPath}/`) ||
        dirs.includes(candidate)
      ) {
        return dirs;
      }
      const other = await q.all(`SELECT 1 FROM files
        WHERE starts_with(path, ${esc(candidate + '/')})
          AND album_id IS DISTINCT FROM ${esc(id)} LIMIT 1`);
      return other.length === 0 ? [...dirs, candidate] : dirs;
    },
  };
}

function createCatalogReadStore(engine: Engine): CatalogReads {
  return {
    artistsPage: (opts) =>
      engine.exclusive((q) => catalogReads(q).artistsPage(opts)),
    getArtistSnapshot: (...args) =>
      engine.exclusive((q) => catalogReads(q).getArtistSnapshot(...args)),
    artistAlbumsPage: (...args) =>
      engine.exclusive((q) => catalogReads(q).artistAlbumsPage(...args)),
    listArtists: (...args) =>
      engine.exclusive((q) => catalogReads(q).listArtists(...args)),
    getArtist: (id) => engine.exclusive((q) => catalogReads(q).getArtist(id)),
    artistById: (id) => engine.exclusive((q) => catalogReads(q).artistById(id)),
    artistIds: (folderId) =>
      engine.exclusive((q) => catalogReads(q).artistIds(folderId)),
    albumsByArtist: (...args) =>
      engine.exclusive((q) => catalogReads(q).albumsByArtist(...args)),
    albumsWithoutArtist: (...args) =>
      engine.exclusive((q) => catalogReads(q).albumsWithoutArtist(...args)),
    listAlbums: (opts) =>
      engine.exclusive((q) => catalogReads(q).listAlbums(opts)),
    albumsById: (...args) =>
      engine.exclusive((q) => catalogReads(q).albumsById(...args)),
    getAlbum: (id) => engine.exclusive((q) => catalogReads(q).getAlbum(id)),
    albumsPage: (opts) =>
      engine.exclusive((q) => catalogReads(q).albumsPage(opts)),
    getAlbumSnapshot: (...args) =>
      engine.exclusive((q) => catalogReads(q).getAlbumSnapshot(...args)),
    getSong: (id) => engine.exclusive((q) => catalogReads(q).getSong(id)),
    getSongSnapshot: (id) =>
      engine.exclusive((q) => catalogReads(q).getSongSnapshot(id)),
    songsPage: (opts) =>
      engine.exclusive((q) => catalogReads(q).songsPage(opts)),
    search3: (...args) =>
      engine.exclusive((q) => catalogReads(q).search3(...args)),
    songPath: (id) => engine.exclusive((q) => catalogReads(q).songPath(id)),
    videos: (folderId) =>
      engine.exclusive((q) => catalogReads(q).videos(folderId)),
    videoDetails: (id) =>
      engine.exclusive((q) => catalogReads(q).videoDetails(id)),
    randomSongs: (input: RandomSongOptions | number, folderId?: string) =>
      engine.exclusive((q) =>
        catalogReads(q).randomSongs(
          typeof input === 'number' ? { size: input, folderId } : input,
        )
      ),
    listSongs: (opts) =>
      engine.exclusive((q) => catalogReads(q).listSongs(opts)),
    listGenres: () => engine.exclusive((q) => catalogReads(q).listGenres()),
    songsByGenre: (...args) =>
      engine.exclusive((q) => catalogReads(q).songsByGenre(...args)),
    songsForLyrics: (query, limit) =>
      engine.exclusive((q) => catalogReads(q).songsForLyrics(query, limit)),
    songForLyrics: (query) =>
      engine.exclusive((q) => catalogReads(q).songForLyrics(query)),
    coverSongPath: (id) =>
      engine.exclusive((q) => catalogReads(q).coverSongPath(id)),
    albumSongPath: (id) =>
      engine.exclusive((q) => catalogReads(q).albumSongPath(id)),
    albumCoverDirectories: (id) =>
      engine.exclusive((q) => catalogReads(q).albumCoverDirectories(id)),
    artistFolder: (id) =>
      engine.exclusive((q) => catalogReads(q).artistFolder(id)),
  };
}

export interface LibraryRow {
  id: string;
  name: string;
  path: string;
  available: boolean;
}

export interface DuplicateGroup {
  fingerprint: string;
  files: { id: string; libraryId: string; relPath: string }[];
}

export interface FileEvent {
  seq: number;
  occurredAtMs: number;
  kind: 'linked' | 'ambiguous' | 'audio_changed';
  fileId: string;
  fingerprint: string | null;
  fromLibraryId: string | null;
  fromPath: string | null;
  toLibraryId: string | null;
  toPath: string | null;
  candidates: string[];
}

export interface CatalogFileStat {
  size: number | null;
  mtime_ms: number | null;
  dev: number | null;
  ino: number | null;
}

export interface CatalogIdentity extends CatalogFileStat {
  id: string;
  library_id: string;
  rel_path: string;
  fingerprint: string | null;
  pcm_md5: string | null;
  album_id: string | null;
}

export interface CatalogFile {
  /** Complete file-owned acquisition cache. Absent on pre-cache installs. */
  scanFacts?: {
    pictures: Omit<LocalVersion, 'origin'>[];
    embeddedLyrics: LyricsSource[];
  };
  albumInput?: Omit<AlbumInput, 'songId'>;
  video?: VideoDetails;
  pictureHash?: string | null;
  metadata?: SongMetadata;
  id: string;
  path: string;
  rel: string;
  libraryId: string;
  stat: CatalogFileStat;
  fingerprint: string | null;
  pcmMd5: string | null;
  title: string | null;
  albumId: string | null;
  artistId: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
  genre: string | null;
  year: number | null;
  isVideo: boolean;
  hasLyrics?: boolean;
}

export interface CatalogEvent {
  kind: FileEvent['kind'];
  file: CatalogFile;
  from?: CatalogIdentity;
  candidates?: string[];
}

export interface CatalogSnapshot {
  coverage?: ScanCoverage;
  scanResult?: ScanResult;
  /** Retained rows participate in album grouping but are never re-indexed. */
  preserved?: { id: string; albumId: string | null }[];
  sources?: { id: string; path: string }[];
  artists: {
    id: string;
    name: string;
    musicBrainzId?: string | null;
    sortName?: string | null;
  }[];
  albums: (Album & { metadata?: AlbumMetadata })[];
  albumIdentities: AlbumIdentity[];
  albumEvents: AlbumEvent[];
  files: CatalogFile[];
  events: CatalogEvent[];
  retainedIds: string[];
}

// The scan's nullable literals use the same escaping owner as every domain.
const nullable = (value: string | null | undefined) =>
  value == null ? 'NULL' : esc(value);

async function replaceCatalog(
  q: Queries,
  snapshot: CatalogSnapshot,
): Promise<void> {
  const { artists, albums, files, events } = snapshot;
  const byId = new Set(snapshot.retainedIds);
  const affected = snapshot.coverage
    ? (await q.all<{ id: string; library_id: string; rel_path: string }>(
      `SELECT id, library_id, rel_path FROM file_identity
       UNION ALL
       SELECT f.id, f.library_id, substring(f.path, length(rtrim(l.path, '/')) + 2) AS rel_path
       FROM files f JOIN libraries l ON l.id = f.library_id
       WHERE NOT EXISTS (SELECT 1 FROM file_identity fi WHERE fi.id = f.id)`,
    ))
      .filter((r) => covered(snapshot.coverage!, r.library_id, r.rel_path)).map(
        (r) => r.id,
      )
    : null;
  const ids = (values: string[]) =>
    values.length ? values.map(esc).join(', ') : "''";
  await q.run(
    `UPDATE file_identity SET present = false${
      affected ? ` WHERE id IN (${ids(affected)})` : ''
    }`,
  );
  for (const file of files) {
    const values = `${esc(file.libraryId)}, ${esc(file.rel)}, true, now(), ${
      file.stat.size ?? 'NULL'
    }, ${file.stat.mtime_ms ?? 'NULL'}, ${file.stat.dev ?? 'NULL'}, ${
      file.stat.ino ?? 'NULL'
    }, ${nullable(file.fingerprint)}, ${nullable(file.pcmMd5)}, ${
      nullable(file.albumId)
    }`;
    if (byId.has(file.id)) {
      await q.run(`UPDATE file_identity SET
          library_id = ${esc(file.libraryId)}, rel_path = ${esc(file.rel)},
          present = true, last_seen_at = now(), size = ${
        file.stat.size ?? 'NULL'
      },
          mtime_ms = ${file.stat.mtime_ms ?? 'NULL'}, dev = ${
        file.stat.dev ?? 'NULL'
      },
          ino = ${file.stat.ino ?? 'NULL'}, fingerprint = ${
        nullable(file.fingerprint)
      },
          pcm_md5 = ${nullable(file.pcmMd5)}, album_id = ${
        nullable(file.albumId)
      } WHERE id = ${esc(file.id)}`);
    } else {
      await q.run(`INSERT INTO file_identity
          (id, first_seen_at, library_id, rel_path, present, last_seen_at, size, mtime_ms, dev, ino, fingerprint, pcm_md5, album_id)
          VALUES (${esc(file.id)}, now(), ${values})`);
    }
  }
  for (const event of events) {
    await q.run(`INSERT INTO file_events
        (occurred_at, kind, file_id, fingerprint, from_library_id, from_path, to_library_id, to_path, candidates)
        VALUES (now(), ${esc(event.kind)}, ${esc(event.file.id)}, ${
      nullable(event.file.fingerprint)
    },
          ${nullable(event.from?.library_id)}, ${
      nullable(event.from?.rel_path)
    },
          ${esc(event.file.libraryId)}, ${esc(event.file.rel)},
          [${(event.candidates ?? []).map(esc).join(', ')}]::VARCHAR[])`);
  }

  // Rebuild catalog tables as before, using the resolved song ids.
  // Grouping includes retained songs, so only absent albums lose presence.
  await q.run(
    `UPDATE album_identity SET present = false WHERE id NOT IN (${
      ids(snapshot.albumIdentities.map((a) => a.id))
    })`,
  );
  for (const identity of snapshot.albumIdentities) {
    await q.run(`INSERT INTO album_identity (id, library_id, root_dir, present)
      VALUES (${esc(identity.id)}, ${esc(identity.libraryId)}, ${
      esc(identity.rootDir)
    }, true)
      ON CONFLICT (id) DO UPDATE SET library_id = excluded.library_id,
        root_dir = excluded.root_dir, present = true`);
  }
  for (const event of snapshot.albumEvents) {
    await q.run(`INSERT INTO album_events
      ("at", kind, album_id, from_library_id, from_root, to_library_id, to_root, candidates)
      VALUES (now(), ${esc(event.kind)}, ${esc(event.albumId)},
        ${nullable(event.from?.libraryId)}, ${nullable(event.from?.rootDir)},
        ${nullable(event.to?.libraryId)}, ${nullable(event.to?.rootDir)},
        [${(event.candidates ?? []).map(esc).join(', ')}]::VARCHAR[])`);
  }
  await q.run(
    `DELETE FROM files${affected ? ` WHERE id IN (${ids(affected)})` : ''}`,
  );
  await q.run(
    `DELETE FROM albums WHERE id NOT IN (${ids(albums.map((a) => a.id))})`,
  );

  const artistStmt = await q.prepare(
    'INSERT INTO artists (id, name, musicbrainz_id, sort_name) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, musicbrainz_id = excluded.musicbrainz_id, sort_name = excluded.sort_name',
  );
  try {
    for (const artist of artists) {
      artistStmt.bindVarchar(1, artist.id);
      artistStmt.bindVarchar(2, artist.name);
      if (artist.musicBrainzId == null) artistStmt.bindNull(3);
      else artistStmt.bindVarchar(3, artist.musicBrainzId);
      if (artist.sortName == null) artistStmt.bindNull(4);
      else artistStmt.bindVarchar(4, artist.sortName);
      await artistStmt.run();
    }
  } finally {
    artistStmt.destroySync();
  }

  const albumStmt = await q.prepare(
    'INSERT INTO albums (id, name, album_artist_id, artist_kind, library_id, root_dir, folder_name) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, album_artist_id = excluded.album_artist_id, artist_kind = excluded.artist_kind, library_id = excluded.library_id, root_dir = excluded.root_dir, folder_name = excluded.folder_name',
  );
  try {
    for (const album of albums) {
      albumStmt.bindVarchar(1, album.id);
      if (album.name === null) albumStmt.bindNull(2);
      else albumStmt.bindVarchar(2, album.name);
      if (album.albumArtistId === null) albumStmt.bindNull(3);
      else albumStmt.bindVarchar(3, album.albumArtistId);
      albumStmt.bindVarchar(4, album.artistKind);
      albumStmt.bindVarchar(5, album.libraryId);
      albumStmt.bindVarchar(6, album.rootDir);
      albumStmt.bindVarchar(7, album.folderName);
      await albumStmt.run();
      await writeMetadata(q, 'albums', album.id, album.metadata);
    }
  } finally {
    albumStmt.destroySync();
  }

  const fileStmt = await q.prepare(
    `INSERT INTO files (id, path, library_id, mtime, size, title, album_id,
        artist_id, track, disc, duration_ms, genre, year, is_video, has_lyrics, picture_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  try {
    for (const file of files) {
      fileStmt.bindVarchar(1, file.id);
      fileStmt.bindVarchar(2, file.path);
      fileStmt.bindVarchar(3, file.libraryId);
      if (file.stat.mtime_ms === null) fileStmt.bindNull(4);
      else fileStmt.bindBigInt(4, BigInt(file.stat.mtime_ms));
      if (file.stat.size === null) fileStmt.bindNull(5);
      else fileStmt.bindBigInt(5, BigInt(file.stat.size));
      if (file.title === null) fileStmt.bindNull(6);
      else fileStmt.bindVarchar(6, file.title);
      if (file.albumId === null) fileStmt.bindNull(7);
      else fileStmt.bindVarchar(7, file.albumId);
      if (file.artistId === null) fileStmt.bindNull(8);
      else fileStmt.bindVarchar(8, file.artistId);
      if (file.track === null) fileStmt.bindNull(9);
      else fileStmt.bindInteger(9, file.track);
      if (file.disc === null) fileStmt.bindNull(10);
      else fileStmt.bindInteger(10, file.disc);
      if (file.durationMs === null) fileStmt.bindNull(11);
      else fileStmt.bindInteger(11, file.durationMs);
      if (file.genre === null) fileStmt.bindNull(12);
      else fileStmt.bindVarchar(12, file.genre);
      if (file.year === null) fileStmt.bindNull(13);
      else fileStmt.bindInteger(13, file.year);
      fileStmt.bindBoolean(14, file.isVideo);
      fileStmt.bindBoolean(15, file.hasLyrics ?? false);
      if (file.pictureHash == null) fileStmt.bindNull(16);
      else fileStmt.bindVarchar(16, file.pictureHash);
      await fileStmt.run();
      await writeMetadata(q, 'files', file.id, file.metadata);
      if (file.albumInput) {
        await q.run(
          `UPDATE files SET album_input = ${
            esc(JSON.stringify(file.albumInput))
          }::JSON WHERE id = ${esc(file.id)}`,
        );
      }
      if (file.scanFacts) {
        await q.run(
          `UPDATE files SET scan_facts = ${
            esc(JSON.stringify(file.scanFacts))
          }::JSON WHERE id = ${esc(file.id)}`,
        );
      }
      if (file.video) {
        await q.run(
          `UPDATE files SET video_details = ${
            esc(JSON.stringify(file.video))
          }::JSON WHERE id = ${esc(file.id)}`,
        );
      }
    }
  } finally {
    fileStmt.destroySync();
  }
  for (const file of snapshot.preserved ?? []) {
    await q.run(
      `UPDATE files SET album_id = ${nullable(file.albumId)} WHERE id = ${
        esc(file.id)
      } AND album_id IS DISTINCT FROM ${nullable(file.albumId)}`,
    );
    await q.run(
      `UPDATE file_identity SET album_id = ${
        nullable(file.albumId)
      } WHERE id = ${esc(file.id)} AND album_id IS DISTINCT FROM ${
        nullable(file.albumId)
      }`,
    );
  }
  await q.run(
    `DELETE FROM artists WHERE id NOT IN (SELECT artist_id FROM files WHERE artist_id IS NOT NULL)
    AND id NOT IN (SELECT album_artist_id FROM albums WHERE album_artist_id IS NOT NULL)`,
  );
}

async function checkLibraryPath(q: Queries, path: string, id?: string) {
  const libraries = await q.all<LibraryRow>(
    'SELECT id, name, path FROM libraries',
  );
  for (const row of libraries) {
    if (row.id === id) continue;
    if (row.path === path) {
      throw new LibraryError(
        'path_duplicate',
        'Library path is already configured',
      );
    }
    const within = (child: string, parent: string) =>
      child.startsWith(parent === '/' ? '/' : `${parent}/`);
    if (within(path, row.path) || within(row.path, path)) {
      throw new LibraryError('path_overlaps', 'Library paths must not overlap');
    }
  }
}

function libraries(q: Queries): Promise<LibraryRow[]> {
  return q.all<LibraryRow>(
    'SELECT l.id, l.name, l.path, COALESCE(s.available, true) AS available FROM libraries l LEFT JOIN scan_libraries s ON s.library_id = l.id ORDER BY l.name, l.id',
  );
}

export function createCatalogStore(engine: Engine) {
  return {
    ...createCatalogReadStore(engine),
    scanFilesSnapshot(): Promise<CatalogFile[]> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<
          SongSqlRow & {
            rel_path: string;
            fingerprint: string | null;
            pcm_md5: string | null;
            mtime: number | null;
            dev: number | null;
            ino: number | null;
            album_input: string | null;
            scan_facts: string | null;
            video_details: string | null;
            artist_kind: ArtistKind;
            album_artist_name: string | null;
            has_lyrics: boolean;
          }
        >(`${
          SONG_SELECT.replace(
            'SELECT f.id,',
            `SELECT fi.rel_path, fi.fingerprint, fi.pcm_md5, f.mtime, fi.dev, fi.ino,
          f.album_input::VARCHAR AS album_input, f.scan_facts::VARCHAR AS scan_facts,
          f.video_details::VARCHAR AS video_details, f.has_lyrics, al.artist_kind,
          (SELECT name FROM artists WHERE id = al.album_artist_id) AS album_artist_name, f.id,`,
          )
        }`);
        return rows.map((row) => {
          const song = songOf(row);
          const libraryId = row.library_id!;
          const rel = row.rel_path ??
            row.path.slice((row.library_path?.length ?? 0) + 1);
          return {
            id: row.id,
            path: row.path,
            rel,
            libraryId,
            stat: {
              size: num(row.size),
              mtime_ms: num(row.mtime),
              dev: num(row.dev),
              ino: num(row.ino),
            },
            fingerprint: row.fingerprint,
            pcmMd5: row.pcm_md5,
            title: row.title,
            albumId: row.album_id,
            artistId: row.artist_id,
            track: num(row.track),
            disc: num(row.disc),
            durationMs: num(row.duration_ms),
            genre: row.genre,
            year: num(row.year),
            isVideo: row.is_video ?? false,
            ...(row.scan_facts
              ? { scanFacts: JSON.parse(row.scan_facts) }
              : {}),
            ...(row.video_details
              ? { video: JSON.parse(row.video_details) }
              : {}),
            hasLyrics: row.has_lyrics,
            metadata: song.metadata,
            pictureHash: row.picture_hash,
            albumInput: row.album_input ? JSON.parse(row.album_input) : {
              libraryId,
              rel,
              albumName: row.album_name,
              albumArtistTag: row.artist_kind === 'tagged'
                ? row.album_artist_name
                : null,
              trackArtist: row.artist_name,
              disc: num(row.disc),
            },
          };
        });
      });
    },
    identitySnapshot(): Promise<CatalogIdentity[]> {
      return engine.exclusive((q) =>
        q.all<CatalogIdentity>(`
    SELECT fi.id, fi.library_id, fi.rel_path, fi.size, fi.mtime_ms, fi.dev, fi.ino,
      fi.fingerprint, fi.pcm_md5, COALESCE(fi.album_id, f.album_id) AS album_id
    FROM file_identity fi LEFT JOIN files f ON f.id = fi.id ORDER BY fi.id`)
      );
    },
    albumIdentitySnapshot(): Promise<AlbumIdentity[]> {
      return engine.exclusive((q) =>
        q.all<AlbumIdentity>(`
        SELECT id, library_id AS "libraryId", root_dir AS "rootDir"
        FROM album_identity ORDER BY id`)
      );
    },
    replaceCatalog(snapshot: CatalogSnapshot): Promise<string[]> {
      return atomic(engine, async (q) => {
        if (snapshot.sources) {
          const current = await q.all<{ id: string; path: string }>(
            'SELECT id, path FROM libraries ORDER BY id',
          );
          const expected = [...snapshot.sources].sort((a, b) =>
            a.id.localeCompare(b.id)
          );
          if (JSON.stringify(current) !== JSON.stringify(expected)) {
            throw new LibrarySourcesChanged();
          }
        }
        await replaceCatalog(q, snapshot);
        const changed = snapshot.scanResult
          ? await writeScanResult(q, snapshot.scanResult)
          : [];
        await advanceCatalogRevision(q);
        return changed;
      });
    },
    libraryCount(): Promise<number> {
      return engine.exclusive(async (q) =>
        (await q.all<{ n: number }>(
          'SELECT COUNT(*) AS n FROM libraries',
        ))[0].n
      );
    },
    duplicates(): Promise<DuplicateGroup[]> {
      return engine.exclusive(async (q) => {
        const rows = await q.all<{
          id: string;
          library_id: string;
          rel_path: string;
          fingerprint: string;
        }>(`
        SELECT id, library_id, rel_path, fingerprint FROM file_identity
        WHERE present AND fingerprint IN (
          SELECT fingerprint FROM file_identity
          WHERE present AND fingerprint IS NOT NULL
          GROUP BY fingerprint HAVING COUNT(*) > 1
        ) ORDER BY fingerprint, rel_path, library_id, id`);
        const groups: DuplicateGroup[] = [];
        for (const row of rows) {
          let group = groups[groups.length - 1];
          if (group?.fingerprint !== row.fingerprint) {
            group = { fingerprint: row.fingerprint, files: [] };
            groups.push(group);
          }
          group.files.push({
            id: row.id,
            libraryId: row.library_id,
            relPath: row.rel_path,
          });
        }
        return groups;
      });
    },
    events({ limit }: { limit: number }): Promise<FileEvent[]> {
      if (!Number.isSafeInteger(limit) || limit < 0) {
        return Promise.reject(new RangeError('invalid event limit'));
      }
      return engine.exclusive(async (q) => {
        const rows = await q.all<{
          seq: number;
          at_ms: number;
          kind: FileEvent['kind'];
          file_id: string;
          fingerprint: string | null;
          from_library_id: string | null;
          from_path: string | null;
          to_library_id: string | null;
          to_path: string | null;
          candidates: string[] | null;
        }>(`
        SELECT seq, epoch_ms(occurred_at)::BIGINT AS at_ms, kind, file_id,
               fingerprint, from_library_id, from_path, to_library_id, to_path,
               candidates FROM file_events ORDER BY seq DESC LIMIT ${limit}`);
        return rows.map((row) => ({
          seq: Number(row.seq),
          occurredAtMs: Number(row.at_ms),
          kind: row.kind,
          fileId: row.file_id,
          fingerprint: row.fingerprint,
          fromLibraryId: row.from_library_id,
          fromPath: row.from_path,
          toLibraryId: row.to_library_id,
          toPath: row.to_path,
          candidates: row.candidates ?? [],
        }));
      });
    },
    firstSeen(ids: string[]): Promise<Record<string, number>> {
      return engine.exclusive(async (q) => {
        if (ids.length === 0) return {};
        const rows = await q.all<{ id: string; at_ms: number }>(`
        SELECT id, epoch_ms(first_seen_at)::BIGINT AS at_ms FROM file_identity
        WHERE id IN (${[...new Set(ids)].map(esc).join(', ')})`);
        const out: Record<string, number> = {};
        for (const row of rows) out[row.id] = Number(row.at_ms);
        return out;
      });
    },
    listLibraries(): Promise<LibraryRow[]> {
      return engine.exclusive(libraries);
    },
    librariesSnapshot(): Promise<
      { libraries: LibraryRow[]; revision: string }
    > {
      return engine.exclusive(async (q) => ({
        libraries: await libraries(q),
        revision: await catalogRevision(q),
      }));
    },
    addLibrary(row: Omit<LibraryRow, 'available'>): Promise<LibraryRow> {
      return atomic(engine, async (q) => {
        await checkLibraryPath(q, row.path);
        // A path hash is the preferred initial ID, not a reservation of that
        // path forever: another library may have kept the ID while moving.
        // Allocate under the same exclusive transaction as the path check.
        let added = { ...row, available: true };
        while (
          (await q.all(`SELECT id FROM libraries WHERE id = ${esc(added.id)}`))
            .length
        ) {
          added = { ...added, id: crypto.randomUUID().replaceAll('-', '') };
        }
        const stmt = await q.prepare(
          'INSERT INTO libraries (id, name, path) VALUES (?, ?, ?)',
        );
        try {
          stmt.bindVarchar(1, added.id);
          stmt.bindVarchar(2, added.name);
          stmt.bindVarchar(3, added.path);
          await stmt.run();
        } finally {
          stmt.destroySync();
        }
        await advanceCatalogRevision(q);
        return added;
      });
    },
    updateLibrary(
      id: string,
      input: { name?: string; path?: string },
    ): Promise<{ library: LibraryRow; pathChanged: boolean }> {
      return atomic(engine, async (q) => {
        const rows = await q.all<LibraryRow>(
          `SELECT l.id, l.name, l.path, COALESCE(s.available, true) AS available FROM libraries l LEFT JOIN scan_libraries s ON s.library_id = l.id WHERE l.id = ${
            esc(id)
          }`,
        );
        if (!rows[0]) throw new LibraryError('not_found', 'Library not found');
        const row = { ...rows[0], ...input };
        await checkLibraryPath(q, row.path, id);
        await q.run(
          `UPDATE libraries SET name = ${esc(row.name)}, path = ${
            esc(row.path)
          } WHERE id = ${esc(id)}`,
        );
        // Effects must use this transaction's before/after fact, never a
        // caller snapshot taken before asynchronous filesystem validation.
        await advanceCatalogRevision(q);
        return { library: row, pathChanged: row.path !== rows[0].path };
      });
    },
    removeLibrary(id: string): Promise<boolean> {
      return atomic(engine, async (q) => {
        const existing = await q.all(
          `SELECT id FROM libraries WHERE id = ${esc(id)}`,
        );
        if (existing.length === 0) return false;
        await q.run(`DELETE FROM libraries WHERE id = ${esc(id)}`);
        await q.run(`DELETE FROM files WHERE library_id = ${esc(id)}`);
        await q.run(
          `DELETE FROM albums WHERE id NOT IN
             (SELECT DISTINCT album_id FROM files WHERE album_id IS NOT NULL)`,
        );
        await q.run(
          `DELETE FROM artists WHERE id NOT IN
             (SELECT album_artist_id FROM albums
               WHERE album_artist_id IS NOT NULL)
           AND id NOT IN
             (SELECT DISTINCT artist_id FROM files
               WHERE artist_id IS NOT NULL)`,
        );
        await advanceCatalogRevision(q);
        return true;
      });
    },
  };
}
