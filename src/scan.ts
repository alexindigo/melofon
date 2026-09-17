// src/scan.ts — walk every configured source (libraries table), read tags,
// rebuild the catalog tables (artists / albums / files) from disk. The users
// table is never touched: catalog IDs are stable content hashes, so a rescan
// of the same paths keeps every ID (M2's stars/playlists survive). Unreadable
// files are skipped and counted, never fatal; an unreadable source root is
// warned about and skipped, never fatal. app.media.probe is the duration
// fallback only (when music-metadata parsed but found no duration) — the
// ffprobe CLI is gone. M4: video containers are walked alongside audio; for
// those, probe also decides is_video (an audio-only .mp4 stays a song) and a
// file with neither audio nor video streams is skipped as not-media.
import { parseFile } from 'music-metadata';
import { encodeHex } from '@std/encoding/hex';
import { createMedia, type Media } from './media.ts';
import type { Db } from './db.ts';

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.ogg',
  '.opus',
  '.wav',
]);

// M4: music videos live in the same sources as audio (Blue Tattoo: MP3s and
// the videos in one album folder).
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.mkv',
  '.webm',
  '.m4v',
]);

export interface ScanCounts {
  files: number;
  skipped: number;
  artists: number;
  albums: number;
}

interface ArtistIn {
  id: string;
  name: string;
}

interface AlbumIn {
  id: string;
  name: string;
  albumArtistId: string;
}

interface FileIn {
  id: string;
  path: string;
  libraryId: string;
  mtime: number | null;
  size: number | null;
  title: string;
  albumId: string | null;
  artistId: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
  genre: string | null;
  year: number | null;
  isVideo: boolean;
}

async function stableId(kind: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${kind}\n${key}`),
  );
  return encodeHex(new Uint8Array(digest)).slice(0, 32);
}

function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? '' : name.slice(idx).toLowerCase();
}

async function* walkMedia(
  root: string,
  dir: string = root,
): AsyncGenerator<{ abs: string; rel: string }> {
  for await (const entry of Deno.readDir(dir)) {
    const abs = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkMedia(root, abs);
    } else if (
      entry.isFile &&
      (AUDIO_EXTENSIONS.has(extOf(entry.name)) ||
        VIDEO_EXTENSIONS.has(extOf(entry.name)))
    ) {
      // rel is anchored at the source ROOT, not the recursion dir — two
      // same-named files in different subdirs must not share an id.
      yield { abs, rel: abs.slice(root.length + 1) };
    }
  }
}

async function probeDurationMs(
  media: Media,
  path: string,
): Promise<number | null> {
  const probe = await media.probe(path);
  return probe.durationMs;
}

export async function scanLibrary(db: Db, media?: Media): Promise<ScanCounts> {
  // node-av (the native addon) is only loaded if some file actually needs the
  // duration fallback — a library whose tags all carry duration never touches
  // it.
  let media_: Media | undefined = media;
  const fallbackMedia = () => (media_ ??= createMedia());
  const sources = await db.conn.runAndReadAll(
    'SELECT id, name, path FROM libraries ORDER BY name',
  );
  const artists = new Map<string, ArtistIn>(); // name → row
  const albums = new Map<string, AlbumIn>(); // id → row
  const files: FileIn[] = [];
  let skipped = 0;

  for (
    const source of sources.getRowObjects() as {
      id: string;
      name: string;
      path: string;
    }[]
  ) {
    const root = source.path.replace(/\/+$/, '');
    try {
      for await (const { abs, rel } of walkMedia(root)) {
        let title: string | undefined;
        let trackArtist: string | undefined;
        let albumName: string | undefined;
        let albumArtist: string | undefined;
        let trackNo: number | null = null;
        let discNo: number | null = null;
        let durationMs: number | null = null;
        let genre: string | null = null;
        let year: number | null = null;
        let isVideo = false;
        try {
          const meta = await parseFile(abs);
          // Garbage bytes resolve with an empty format (no container, no codec)
          // rather than throwing — unrecognized audio is unreadable too.
          if (
            meta.format.container === undefined &&
            meta.format.codec === undefined
          ) {
            throw new Error('unrecognized audio format');
          }
          title = meta.common.title?.trim() || undefined;
          trackArtist = meta.common.artist?.trim() || undefined;
          albumName = meta.common.album?.trim() || undefined;
          // TPE2 (album artist) wins — household VA/OST rule; TPE1 is the track
          // artist. Fallback: album-level artist = track artist.
          albumArtist = meta.common.albumartist?.trim() || trackArtist;
          trackNo = meta.common.track.no;
          discNo = meta.common.disk.no;
          if (meta.format.duration && meta.format.duration > 0) {
            durationMs = Math.round(meta.format.duration * 1000);
          }
          // TCON is multi-valued; the catalog keeps the first (single-valued,
          // like the track artist fallback).
          genre = meta.common.genre?.[0]?.trim() || null;
          year = meta.common.year ?? null;
        } catch {
          skipped++;
          continue; // unreadable tags — skip the file, keep scanning
        }
        if (VIDEO_EXTENSIONS.has(extOf(abs))) {
          // Video containers: probe decides video-ness (an audio-only .mp4
          // stays a song) and backfills the duration when tags didn't carry
          // one. Neither stream type → not media at all — skip like
          // unreadable audio.
          const probe = await fallbackMedia().probe(abs);
          if (!probe.hasVideo && !probe.hasAudio) {
            skipped++;
            continue;
          }
          isVideo = probe.hasVideo;
          durationMs ??= probe.durationMs;
        } else if (durationMs === null) {
          durationMs = await probeDurationMs(fallbackMedia(), abs);
        }

        const stat = await Deno.stat(abs).catch(() => null);
        const name = rel.split('/').pop()!.replace(/\.[^.]*$/, '');
        let artistId: string | null = null;
        if (trackArtist !== undefined) {
          artistId = await stableId('artist', trackArtist);
          artists.set(trackArtist, { id: artistId, name: trackArtist });
        }
        let albumId: string | null = null;
        if (albumName !== undefined && albumArtist !== undefined) {
          albumId = await stableId('album', `${albumArtist}\n${albumName}`);
          const albumArtistId = await stableId('artist', albumArtist);
          artists.set(albumArtist, { id: albumArtistId, name: albumArtist });
          albums.set(albumId, { id: albumId, name: albumName, albumArtistId });
        }
        files.push({
          // The same relative path can exist in two sources — the library id
          // is part of the key, so disjoint folders never collide.
          id: await stableId('file', `${source.id}\n${rel}`),
          path: abs,
          libraryId: source.id,
          mtime: stat?.mtime?.getTime() ?? null,
          size: stat?.size ?? null,
          title: title ?? name,
          albumId,
          artistId,
          track: trackNo,
          disc: discNo,
          durationMs,
          genre,
          year,
          isVideo,
        });
      }
    } catch (err) {
      if (
        err instanceof Deno.errors.NotFound ||
        err instanceof Deno.errors.PermissionDenied
      ) {
        console.warn(
          `[melofon] scan: skipping unreadable source ` +
            `${source.name} (${root}): ${err.message}`,
        );
        continue;
      }
      throw err;
    }
  }

  // Rebuild catalog tables from disk; users/listens are never touched.
  await db.conn.run('BEGIN TRANSACTION');
  try {
    await db.conn.run('DELETE FROM files');
    await db.conn.run('DELETE FROM albums');
    await db.conn.run('DELETE FROM artists');

    const artistStmt = await db.conn.prepare(
      'INSERT INTO artists (id, name) VALUES (?, ?)',
    );
    for (const artist of artists.values()) {
      artistStmt.bindVarchar(1, artist.id);
      artistStmt.bindVarchar(2, artist.name);
      await artistStmt.run();
    }
    artistStmt.destroySync();

    const albumStmt = await db.conn.prepare(
      'INSERT INTO albums (id, name, album_artist_id) VALUES (?, ?, ?)',
    );
    for (const album of albums.values()) {
      albumStmt.bindVarchar(1, album.id);
      albumStmt.bindVarchar(2, album.name);
      albumStmt.bindVarchar(3, album.albumArtistId);
      await albumStmt.run();
    }
    albumStmt.destroySync();

    const fileStmt = await db.conn.prepare(
      `INSERT INTO files (id, path, library_id, mtime, size, title, album_id,
        artist_id, track, disc, duration_ms, genre, year, is_video)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const file of files) {
      fileStmt.bindVarchar(1, file.id);
      fileStmt.bindVarchar(2, file.path);
      fileStmt.bindVarchar(3, file.libraryId);
      if (file.mtime === null) fileStmt.bindNull(4);
      else fileStmt.bindBigInt(4, BigInt(file.mtime));
      if (file.size === null) fileStmt.bindNull(5);
      else fileStmt.bindBigInt(5, BigInt(file.size));
      fileStmt.bindVarchar(6, file.title);
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
      await fileStmt.run();
    }
    fileStmt.destroySync();

    await db.conn.run('COMMIT');
  } catch (err) {
    await db.conn.run('ROLLBACK');
    throw err;
  }

  return {
    files: files.length,
    skipped,
    artists: artists.size,
    albums: albums.size,
  };
}

// --- Scan state (getScanStatus / startScan) ----------------------------------

export interface ScanStatus {
  scanning: boolean;
  /** Files indexed by the last completed scan (0 before the first). */
  count: number;
  /** Configured sources (Navidrome's folderCount extra). */
  folderCount: number;
  /** Completion time of the last scan (Navidrome's lastScan extra). */
  lastScanMs: number | null;
}

export interface ScanService {
  /** Foreground scan (boot); refreshes count/lastScanMs on completion. */
  run(): Promise<ScanCounts>;
  status(): Promise<ScanStatus>;
  /** Background scan (startScan); no-op while one runs. Resolves when done. */
  start(): Promise<void>;
}

export function createScan(db: Db, media?: Media): ScanService {
  let scanning = false;
  let count = 0;
  let lastScanMs: number | null = null;
  const run = async (): Promise<ScanCounts> => {
    const counts = await scanLibrary(db, media);
    count = counts.files;
    lastScanMs = Date.now();
    return counts;
  };
  return {
    run,
    async status(): Promise<ScanStatus> {
      const res = await db.conn.runAndReadAll(
        'SELECT COUNT(*) AS n FROM libraries',
      );
      const folderCount = Number(
        (res.getRowObjects() as { n: bigint }[])[0].n,
      );
      return { scanning, count, folderCount, lastScanMs };
    },
    async start(): Promise<void> {
      if (scanning) return;
      scanning = true;
      try {
        await run();
      } catch (err) {
        console.error('[melofon] scan failed:', err);
      } finally {
        scanning = false;
      }
    },
  };
}
