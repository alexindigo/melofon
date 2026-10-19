// The scan owns catalog rebuilds and retained file identity. Song ids are
// assigned once, then resolved before rebuilding files so user state follows
// unambiguous external moves. All identity/catalog writes share one transaction.
import { type AlbumInput, groupAlbums, stableId } from './albums.ts';
import { type AudioFingerprint, createMedia, type Media } from './media.ts';
import type { Store } from './store/index.ts';
import type {
  CatalogEvent as EventIn,
  CatalogFile as FileIn,
  CatalogFileStat as FileStat,
  CatalogIdentity as IdentityRow,
} from './store/catalog.ts';
import type { Notify } from './notify.ts';
import { type Log, scopedLog } from './logging.ts';
import {
  embeddedPictures as picturesFromMetadata,
  imageExtension,
  imageHash,
  isCoverFile,
  libraryImagesWritable,
} from './images.ts';
import type { LocalVersion } from './store/candidates.ts';
import { createLyrics, type Lyrics, type LyricsSource } from './lyrics.ts';
import {
  albumMetadata,
  metadataFromTags,
  type SongMetadata,
} from './metadata.ts';
import { createState, type State } from './state.ts';
import {
  createTagReader,
  declareTagSettings,
  type TagReader,
} from './scan-tags.ts';

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

function pathKey(libraryId: string, rel: string): string {
  return JSON.stringify([libraryId, rel]);
}

function statKey(stat: FileStat): string | null {
  const fields = [stat.dev, stat.ino, stat.size, stat.mtime_ms];
  return fields.some((n) => n === null) ? null : fields.join('/');
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
      if (!entry.name.startsWith('.')) yield* walkMedia(root, abs);
    } else if (
      entry.isFile &&
      (AUDIO_EXTENSIONS.has(extOf(entry.name)) ||
        VIDEO_EXTENSIONS.has(extOf(entry.name)) || isCoverFile(entry.name))
    ) {
      // Anchor at the source root, not the recursion dir: same-named files
      // in different subdirectories must not share an identity path.
      yield { abs, rel: abs.slice(root.length + 1) };
    }
  }
}

export async function scanLibrary(
  store: Store,
  media?: Media,
  log: Log = scopedLog('scan'),
  lyrics: Lyrics = createLyrics(store),
  options: { state?: State; tagReader?: TagReader } = {},
): Promise<ScanCounts> {
  using tagReader = options.tagReader ??
    createTagReader(options.state ?? createState(store));
  let media_: Media | undefined = media;
  const fallbackMedia = () => (media_ ??= createMedia());
  const sources = await store.catalog.listLibraries();
  // Read-only preparation: previous rows remain unchanged until the transaction.
  const retained = await store.catalog.identitySnapshot();
  const retainedAlbums = await store.catalog.albumIdentitySnapshot();
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
  const albumInputs = new Map<FileIn, Omit<AlbumInput, 'songId'>>();
  const files: FileIn[] = [];
  const embeddedPictures = new Map<FileIn, Omit<LocalVersion, 'origin'>[]>();
  const coverPictures = new Map<string, LocalVersion>();
  const songLyrics = new Map<FileIn, LyricsSource[]>();
  let skipped = 0;

  for (const source of sources) {
    const root = source.path.replace(/\/+$/, '');
    try {
      for await (const { abs, rel } of walkMedia(root)) {
        if (isCoverFile(rel.slice(rel.lastIndexOf('/') + 1))) {
          try {
            coverPictures.set(abs, {
              imageHash: await imageHash(await Deno.readFile(abs)),
              imageExt: imageExtension(extOf(abs).slice(1)),
              libraryId: source.id,
              origin: rel,
            });
          } catch (error) {
            if (
              !(error instanceof Deno.errors.NotFound ||
                error instanceof Deno.errors.PermissionDenied)
            ) throw error;
          }
          continue;
        }
        const info = await Deno.stat(abs).catch(() => null);
        const stat: FileStat = {
          size: info?.size ?? null,
          mtime_ms: info?.mtime?.getTime() ?? null,
          dev: info?.dev ?? null,
          ino: info?.ino ?? null,
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
        let metadata: SongMetadata;
        let pictures: Omit<LocalVersion, 'origin'>[] = [];
        try {
          const meta = await tagReader.read(abs);
          metadata = metadataFromTags(meta);
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
          // Preserve the tagged fact. Album-level inference owns the fallback.
          albumArtist = meta.common.albumartist?.trim() || undefined;
          trackNo = meta.common.track.no;
          discNo = meta.common.disk.no;
          if (meta.format.duration && meta.format.duration > 0) {
            durationMs = Math.round(meta.format.duration * 1000);
          }
          // TCON is multi-valued; keep its first value, as before.
          genre = metadata.genres[0] ?? null;
          year = meta.common.year ?? null;
          pictures = await Promise.all(
            picturesFromMetadata(meta).map(async (picture) => ({
              imageHash: await imageHash(picture.data),
              imageExt: imageExtension(picture.format),
              libraryId: source.id,
            })),
          );
        } catch (error) {
          log.event('scan_tags_failed', { path: abs, error });
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
        // Same selected stream as the decoder/transcoder (Demuxer.audio()).
        // Container averages and the tag parser's first stream are not audio facts.
        const details = await fallbackMedia().describeAudio(abs);
        metadata.bitRate = details?.audioBitrate === undefined
          ? null
          : details.audioBitrate / 1000;
        metadata.bitDepth = details?.audioBitdepth ?? null;
        metadata.sampleRate = details?.audioSamplerate ?? null;
        metadata.channels = details?.audioChannels ?? null;

        let artistId: string | null = null;
        if (trackArtist !== undefined) {
          artistId = await stableId('artist', trackArtist);
          artists.set(trackArtist, { id: artistId, name: trackArtist });
        }
        const file: FileIn = {
          id: '',
          path: abs,
          rel,
          libraryId: source.id,
          stat,
          ...audio,
          title: title ?? null,
          albumId: null,
          artistId,
          track: trackNo,
          disc: discNo,
          durationMs,
          genre,
          year,
          isVideo,
          metadata,
        };
        files.push(file);
        const localLyrics = await lyrics.sources(abs);
        file.hasLyrics = localLyrics.length > 0;
        songLyrics.set(file, localLyrics);
        embeddedPictures.set(file, pictures);
        albumInputs.set(file, {
          libraryId: source.id,
          rel,
          albumName: albumName ?? null,
          albumArtistTag: albumArtist ?? null,
          trackArtist: trackArtist ?? null,
          disc: discNo,
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

  const grouped = await groupAlbums(
    files.map((f) => ({ ...albumInputs.get(f)!, songId: f.id })),
    sources,
    new Map(retained.map((r) => [r.id, r.album_id])),
    retainedAlbums,
  );
  for (const file of files) file.albumId = grouped.fileAlbums.get(file.id)!;
  for (const album of grouped.albums) {
    if (album.artistName !== null) {
      artists.set(album.artistName, {
        id: album.albumArtistId!,
        name: album.artistName,
      });
    }
  }
  await store.catalog.replaceCatalog({
    artists: [...artists.values()],
    albums: grouped.albums.map((album) => ({
      ...album,
      metadata: albumMetadata(
        files.filter((file) => file.albumId === album.id),
      ),
    })),
    albumIdentities: grouped.identities,
    albumEvents: grouped.events,
    files,
    events,
    retainedIds: [...byId.keys()],
  });
  // Catalog owns album/root eligibility. Hashes are already prepared outside its
  // exclusive slot; candidates own the separate atomic reconciliation.
  const picturesByAlbum = new Map<string, Map<string, LocalVersion>>();
  for (const file of files) {
    const versions = picturesByAlbum.get(file.albumId!) ??
      new Map<string, LocalVersion>();
    for (const picture of embeddedPictures.get(file) ?? []) {
      if (!versions.has(picture.imageHash)) {
        versions.set(picture.imageHash, { ...picture, origin: file.id });
      }
    }
    picturesByAlbum.set(file.albumId!, versions);
  }
  const writable = new Map<string, boolean>();
  for (const album of grouped.albums) {
    const versions = picturesByAlbum.get(album.id)!;
    const dirs = new Set(await store.catalog.albumCoverDirectories(album.id));
    for (const [path, picture] of coverPictures) {
      if (
        dirs.has(path.slice(0, path.lastIndexOf('/'))) &&
        !versions.has(picture.imageHash)
      ) {
        versions.set(picture.imageHash, picture);
      }
    }
    if (versions.size > 1 && !writable.has(album.libraryId)) {
      writable.set(
        album.libraryId,
        await libraryImagesWritable(
          sources.find((s) => s.id === album.libraryId)!,
        ),
      );
    }
    await store.candidates.replaceLocal(
      album.id,
      versions.size > 1 && writable.get(album.libraryId)
        ? [...versions.values()]
        : [],
    );
  }
  for (const file of files) {
    await lyrics.reconcile(
      file.id,
      sources.find((source) => source.id === file.libraryId)!,
      songLyrics.get(file) ?? [],
    );
  }
  return {
    files: files.length,
    skipped,
    artists: artists.size,
    albums: grouped.albums.length,
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
  store: Store,
  media?: Media,
  opts?: { notify?: Notify; log?: Log; lyrics?: Lyrics; state?: State },
): ScanService {
  const log = opts?.log ?? scopedLog('scan');
  const state = opts?.state ?? createState(store);
  declareTagSettings(state);
  let pending: Promise<ScanCounts> | null = null;
  let count = 0;
  let lastScanMs: number | null = null;
  let lastScanStartedMs: number | null = null;
  const run = (): Promise<ScanCounts> => {
    if (pending !== null) return pending;
    lastScanStartedMs = Date.now();
    pending = (async () => {
      const counts = await scanLibrary(store, media, log, opts?.lyrics, {
        state,
      });
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
      const folderCount = await store.catalog.libraryCount();
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
