// The scan owns catalog rebuilds and retained file identity. Song ids are
// assigned once, then resolved before rebuilding files so user state follows
// unambiguous external moves. All identity/catalog writes share one transaction.
import { parseFile } from 'music-metadata';
import { encodeHex } from '@std/encoding/hex';
import { type AudioFingerprint, createMedia, type Media } from './media.ts';
import type { Db } from './db.ts';
import type { Notify } from './notify.ts';
import { type Log, scopedLog } from './logging.ts';

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.ogg',
  '.opus',
  '.wav',
]);

// Music videos live in the same sources as audio.
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
interface FileStat {
  size: bigint | null;
  mtime_ms: bigint | null;
  dev: bigint | null;
  ino: bigint | null;
}
interface IdentityRow extends FileStat {
  id: string;
  library_id: string;
  rel_path: string;
  fingerprint: string | null;
  pcm_md5: string | null;
}
interface FileIn extends AudioFingerprint {
  id: string;
  path: string;
  rel: string;
  libraryId: string;
  stat: FileStat;
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
interface EventIn {
  kind: 'linked' | 'ambiguous' | 'audio_changed';
  file: FileIn;
  from?: IdentityRow;
  candidates?: string[];
}

async function stableId(kind: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${kind}\n${key}`),
  );
  return encodeHex(new Uint8Array(digest)).slice(0, 32);
}

function pathKey(libraryId: string, rel: string): string {
  return JSON.stringify([libraryId, rel]);
}

function statKey(stat: FileStat): string | null {
  const fields = [stat.dev, stat.ino, stat.size, stat.mtime_ms];
  return fields.some((n) => n === null) ? null : fields.join('/');
}

function esc(value: string | null | undefined): string {
  return value == null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
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
      // Anchor at the source root, not the recursion dir: same-named files
      // in different subdirectories must not share an identity path.
      yield { abs, rel: abs.slice(root.length + 1) };
    }
  }
}

export async function scanLibrary(
  db: Db,
  media?: Media,
  log: Log = scopedLog('scan'),
): Promise<ScanCounts> {
  let media_: Media | undefined = media;
  const fallbackMedia = () => (media_ ??= createMedia());
  const sources = await db.conn.runAndReadAll(
    'SELECT id, name, path FROM libraries ORDER BY name',
  );
  // Read-only preparation: previous rows remain unchanged until the transaction.
  const retained = (await db.conn.runAndReadAll(`
    SELECT id, library_id, rel_path, size, mtime_ms, dev, ino, fingerprint, pcm_md5
    FROM file_identity ORDER BY id`))
    .getRowObjects() as unknown as IdentityRow[];
  const byId = new Map(retained.map((row) => [row.id, row]));
  const byPath = new Map<string, IdentityRow>();
  const byStat = new Map<string, IdentityRow>();
  const byFingerprint = new Map<string, IdentityRow[]>();
  for (const row of retained) {
    const key = pathKey(row.library_id, row.rel_path);
    if (byPath.has(key)) throw new Error('duplicate retained identity path');
    byPath.set(key, row);
    const cacheKey = statKey(row);
    if (cacheKey !== null) byStat.set(cacheKey, row);
    if (row.fingerprint !== null) {
      const group = byFingerprint.get(row.fingerprint) ?? [];
      group.push(row);
      byFingerprint.set(row.fingerprint, group);
    }
  }
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
        const info = await Deno.stat(abs).catch(() => null);
        const asBigInt = (n: number | null | undefined) =>
          n == null ? null : BigInt(n);
        const stat: FileStat = {
          size: asBigInt(info?.size),
          mtime_ms: asBigInt(info?.mtime?.getTime()),
          dev: asBigInt(info?.dev),
          ino: asBigInt(info?.ino),
        };
        const cacheKey = statKey(stat);
        const previous = byPath.get(pathKey(source.id, rel));
        const cached = cacheKey === null
          ? undefined
          : previous && statKey(previous) === cacheKey
          ? previous
          : byStat.get(cacheKey);
        let audio: AudioFingerprint;
        if (cached !== undefined) {
          audio = { fingerprint: cached.fingerprint, pcmMd5: cached.pcm_md5 };
        } else {
          try {
            audio = await fallbackMedia().fingerprint(abs);
          } catch (error) {
            audio = { fingerprint: null, pcmMd5: null };
            log.event('scan_fingerprint_failed', { path: abs, error });
          }
        }

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
          // Garbage bytes can resolve with an empty format rather than throw.
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
          // TCON is multi-valued; keep its first value, as before.
          genre = meta.common.genre?.[0]?.trim() || null;
          year = meta.common.year ?? null;
        } catch {
          skipped++;
          continue; // unreadable tags — skip the file, keep scanning
        }
        if (VIDEO_EXTENSIONS.has(extOf(abs))) {
          // Probe decides video-ness and backfills missing duration. An
          // audio-only .mp4 stays a song, and a streamless file is skipped.
          const probe = await fallbackMedia().probe(abs);
          if (!probe.hasVideo && !probe.hasAudio) {
            skipped++;
            continue;
          }
          isVideo = probe.hasVideo;
          durationMs ??= probe.durationMs;
        } else if (durationMs === null) {
          durationMs = (await fallbackMedia().probe(abs)).durationMs;
        }

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
          id: '',
          path: abs,
          rel,
          libraryId: source.id,
          stat,
          ...audio,
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
        log.event('scan_skipped', { path: root, error: err });
        continue;
      }
      throw err;
    }
  }

  // Resolve the whole walk together: linking during the walk would make an
  // ambiguous group depend on filesystem traversal order.
  const seen = new Set<string>();
  const fresh: FileIn[] = [];
  const newByFingerprint = new Map<string, FileIn[]>();
  const events: EventIn[] = [];
  for (const file of files) {
    const row = byPath.get(pathKey(file.libraryId, file.rel));
    if (row !== undefined) {
      file.id = row.id;
      seen.add(row.id);
      if (
        row.fingerprint !== null && file.fingerprint !== null &&
        row.fingerprint !== file.fingerprint
      ) {
        events.push({ kind: 'audio_changed', file, from: row });
      }
    } else {
      fresh.push(file);
      if (file.fingerprint !== null) {
        const group = newByFingerprint.get(file.fingerprint) ?? [];
        group.push(file);
        newByFingerprint.set(file.fingerprint, group);
      }
    }
  }
  const candidates = new Map<string, IdentityRow[]>();
  for (const [fp, rows] of byFingerprint) {
    candidates.set(
      fp,
      rows.filter((row) => !seen.has(row.id)),
    );
  }
  const reservedIds = new Set(byId.keys());
  for (const file of fresh) {
    const matches = file.fingerprint === null
      ? []
      : candidates.get(file.fingerprint) ?? [];
    if (
      matches.length === 1 &&
      newByFingerprint.get(file.fingerprint!)?.length === 1
    ) {
      file.id = matches[0].id;
      events.push({ kind: 'linked', file, from: matches[0] });
    } else {
      const key = `${file.libraryId}\n${file.rel}`;
      file.id = await stableId('file', key);
      for (let n = 1; reservedIds.has(file.id); n++) {
        file.id = await stableId('file', `${key}\n${n}`);
      }
      reservedIds.add(file.id);
      if (matches.length > 0) {
        events.push({
          kind: 'ambiguous',
          file,
          candidates: matches.map((row) => row.id),
        });
      }
    }
    seen.add(file.id);
  }

  await db.conn.run('BEGIN TRANSACTION');
  try {
    await db.conn.run('UPDATE file_identity SET present = false');
    for (const file of files) {
      const values = `${esc(file.libraryId)}, ${esc(file.rel)}, true, now(), ${
        file.stat.size ?? 'NULL'
      }, ${file.stat.mtime_ms ?? 'NULL'}, ${file.stat.dev ?? 'NULL'}, ${
        file.stat.ino ?? 'NULL'
      }, ${esc(file.fingerprint)}, ${esc(file.pcmMd5)}`;
      if (byId.has(file.id)) {
        await db.conn.run(`UPDATE file_identity SET
          library_id = ${esc(file.libraryId)}, rel_path = ${esc(file.rel)},
          present = true, last_seen_at = now(), size = ${
          file.stat.size ?? 'NULL'
        },
          mtime_ms = ${file.stat.mtime_ms ?? 'NULL'}, dev = ${
          file.stat.dev ?? 'NULL'
        },
          ino = ${file.stat.ino ?? 'NULL'}, fingerprint = ${
          esc(file.fingerprint)
        },
          pcm_md5 = ${esc(file.pcmMd5)} WHERE id = ${esc(file.id)}`);
      } else {
        await db.conn.run(`INSERT INTO file_identity
          (id, first_seen_at, library_id, rel_path, present, last_seen_at, size, mtime_ms, dev, ino, fingerprint, pcm_md5)
          VALUES (${esc(file.id)}, now(), ${values})`);
      }
    }
    for (const event of events) {
      await db.conn.run(`INSERT INTO file_events
        (occurred_at, kind, file_id, fingerprint, from_library_id, from_path, to_library_id, to_path, candidates)
        VALUES (now(), ${esc(event.kind)}, ${esc(event.file.id)}, ${
        esc(event.file.fingerprint)
      },
          ${esc(event.from?.library_id)}, ${esc(event.from?.rel_path)},
          ${esc(event.file.libraryId)}, ${esc(event.file.rel)},
          [${(event.candidates ?? []).map(esc).join(', ')}]::VARCHAR[])`);
    }

    // Rebuild catalog tables as before, using the resolved song ids.
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
      if (file.stat.mtime_ms === null) fileStmt.bindNull(4);
      else fileStmt.bindBigInt(4, file.stat.mtime_ms);
      if (file.stat.size === null) fileStmt.bindNull(5);
      else fileStmt.bindBigInt(5, file.stat.size);
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

export interface ScanStatus {
  scanning: boolean;
  /** Files indexed by the last completed scan (0 before the first). */
  count: number;
  /** Configured sources (Navidrome's folderCount extra). */
  folderCount: number;
  /** Completion time of the last scan (Navidrome's lastScan extra). */
  lastScanMs: number | null;
  /** Start time of the latest scan, for conditional catalog reads. */
  lastScanStartedMs: number | null;
}
export interface ScanService {
  /** Foreground scan. Concurrent callers await the same result. */
  run(): Promise<ScanCounts>;
  status(): Promise<ScanStatus>;
  /** Background entry point, sharing run's single-flight and logging failures. */
  start(): Promise<void>;
}

export function createScan(
  db: Db,
  media?: Media,
  opts?: { notify?: Notify; log?: Log },
): ScanService {
  const log = opts?.log ?? scopedLog('scan');
  let pending: Promise<ScanCounts> | null = null;
  let count = 0;
  let lastScanMs: number | null = null;
  let lastScanStartedMs: number | null = null;
  const run = (): Promise<ScanCounts> => {
    if (pending !== null) return pending;
    lastScanStartedMs = Date.now();
    pending = (async () => {
      const counts = await scanLibrary(db, media, log);
      count = counts.files;
      lastScanMs = Date.now();
      // Core emits after successful completion; hats just consume the event.
      opts?.notify?.emit(['database']);
      return counts;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
  return {
    run,
    async status() {
      const res = await db.conn.runAndReadAll(
        'SELECT COUNT(*) AS n FROM libraries',
      );
      const folderCount = Number((res.getRowObjects() as { n: bigint }[])[0].n);
      return {
        scanning: pending !== null,
        count,
        folderCount,
        lastScanMs,
        lastScanStartedMs,
      };
    },
    async start() {
      try {
        await run();
      } catch (error) {
        log.event('scan_failed', { error });
      }
    },
  };
}
