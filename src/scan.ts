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
  artistImagePaths,
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
  artistMusicBrainzIds,
  metadataFromTags,
  type SongMetadata,
} from './metadata.ts';
import { createState, type State } from './state.ts';
import { type VideoDetails, videoDetails } from './video.ts';
import { LibrarySourcesChanged } from './library-errors.ts';
import { join, relative } from 'node:path';
import {
  covered,
  mergeScanScopes,
  type ScanCoverage,
  type ScanScope,
  type ScanSelection,
  scanTargets,
  validateScanScope,
} from './scan-scope.ts';
import type { ScanMode, ScanProblem, ScanProblemKind } from './store/scan.ts';
import { LibraryError } from './library-errors.ts';
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
  skippedByKind: Record<ScanProblemKind, number>;
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
  unreadable: (path: string, error: unknown) => void,
  dir: string = root,
): AsyncGenerator<{ abs: string; rel: string }> {
  // Catch only directory acquisition, never a consumer's file processing.
  // Buffer before yielding so partial reads cannot invalidate emitted coverage.
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch (error) {
    unreadable(relative(root, dir), error);
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory) {
      if (!entry.name.startsWith('.')) yield* walkMedia(root, unreadable, abs);
    } else if (
      entry.isFile &&
      (AUDIO_EXTENSIONS.has(extOf(entry.name)) ||
        VIDEO_EXTENSIONS.has(extOf(entry.name)) || isCoverFile(entry.name))
    ) {
      // Anchor at the source root, not the recursion dir: same-named files
      // in different subdirectories must not share an identity path.
      yield { abs, rel: relative(root, abs) };
    }
  }
}

export async function scanLibrary(
  store: Store,
  media?: Media,
  log: Log = scopedLog('scan'),
  lyrics: Lyrics = createLyrics(store),
  options: {
    state?: State;
    tagReader?: TagReader;
    scope?: ScanScope;
    selection?: ScanSelection;
    mode?: ScanMode;
    startedAt?: string;
    progress?: (progress: ScanProgress) => void;
    notify?: Notify;
  } = {},
): Promise<ScanCounts> {
  using tagReader = options.tagReader ??
    createTagReader(options.state ?? createState(store));
  let media_: Media | undefined = media;
  const fallbackMedia = () => (media_ ??= createMedia());
  const sources = await store.catalog.listLibraries();
  const selected: ScanSelection = options.selection ?? options.scope ?? {};
  const scope: ScanSelection = selected.scopes
    ? {
      scopes: await Promise.all(
        selected.scopes.map((s) => validateScanScope(s, sources)),
      ),
    }
    : await validateScanScope(selected, sources);
  const mode = options.mode ?? 'full';
  const startedAt = options.startedAt ?? new Date().toISOString();
  const targets = scanTargets(scope, sources);
  const coverage: ScanCoverage = {
    libraries: [...new Set(targets.map((t) => t.library))],
    targets,
    excluded: [],
  };
  const progress: ScanProgress = {
    phase: 'walking',
    mode,
    scope,
    librariesDone: 0,
    librariesTotal: coverage.libraries.length,
    filesSeen: 0,
    filesRead: 0,
    problems: 0,
    startedAt,
    elapsedMs: 0,
  };
  const report = (phase = progress.phase) => {
    progress.phase = phase;
    progress.elapsedMs = Date.now() - Date.parse(startedAt);
    options.progress?.({ ...progress });
  };
  report();
  const oldFiles = await store.catalog.scanFilesSnapshot();
  const oldByPath = new Map(
    oldFiles.map((f) => [pathKey(f.libraryId, f.rel), f]),
  );
  const runId = crypto.randomUUID();
  const problems: ScanProblem[] = [];
  const availability: { id: string; available: boolean }[] = [];
  const skippedByKind: Record<ScanProblemKind, number> = {
    folder_unreadable: 0,
    root_unavailable: 0,
    tags_unreadable: 0,
    no_streams: 0,
    fingerprint_failed: 0,
  };
  const problem = (
    libraryId: string,
    path: string,
    kind: ScanProblemKind,
    error: unknown,
  ) => {
    problems.push({
      runId,
      libraryId,
      path,
      kind,
      message: error instanceof Error ? error.message : String(error),
    });
    skippedByKind[kind]++;
    progress.problems++;
    report();
    if (kind !== 'fingerprint_failed') {
      coverage.excluded.push({ library: libraryId, path });
    }
  };
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
    if (!coverage.libraries.includes(source.id)) continue;
    report('walking');
    const root = source.path.replace(/\/+$/, '') || '/';
    let available = true;
    const unreadable = (path: string, error: unknown) => {
      if (path === '') available = false;
      problem(
        source.id,
        path,
        path === '' ? 'root_unavailable' : 'folder_unreadable',
        error,
      );
      log.event('scan_skipped', { path: join(root, path), error });
    };
    // Even a folder scan reports root availability, independently of its target.
    if (targets.some((t) => t.library === source.id && t.path !== '')) {
      try {
        for await (const _entry of Deno.readDir(root)) { /* exhaust */ }
      } catch (error) {
        unreadable('', error);
      }
    }
    for (const target of targets.filter((t) => t.library === source.id)) {
      for await (
        const { abs, rel } of available
          ? walkMedia(root, unreadable, join(root, target.path))
          : []
      ) {
        try {
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
          progress.filesSeen++;
          report('reading');
          const stat: FileStat = {
            size: info?.size ?? null,
            mtime_ms: info?.mtime?.getTime() ?? null,
            dev: info?.dev ?? null,
            ino: info?.ino ?? null,
          };
          const cacheKey = statKey(stat);
          const previous = byPath.get(pathKey(source.id, rel));
          if (!info) {
            problem(
              source.id,
              rel,
              'tags_unreadable',
              'File could not be read',
            );
            skipped++;
            continue;
          }
          const old = oldByPath.get(pathKey(source.id, rel));
          if (
            mode === 'quick' && cacheKey !== null && old?.scanFacts &&
            statKey(old.stat) === cacheKey
          ) {
            using _readable = await Deno.open(abs, { read: true });
            const file: FileIn = { ...old, path: abs, stat };
            if (old.video) {
              file.video = await videoDetails(
                abs,
                old.video.audio,
                old.video.subtitles,
              );
            }
            // File tags/probes are cached; sidecars and directory pictures are
            // independent filesystem inputs and must still be observed.
            const localLyrics = await lyrics.sources(
              abs,
              old.scanFacts.embeddedLyrics,
            );
            file.hasLyrics = localLyrics.length > 0;
            songLyrics.set(file, localLyrics);
            embeddedPictures.set(file, old.scanFacts.pictures);
            albumInputs.set(file, file.albumInput!);
            files.push(file);
            continue;
          }
          progress.filesRead++;
          report();
          // A streamless video container has no tags to parse. Classify it before
          // tag parsing so the failure has one useful owner and kind.
          const probe = VIDEO_EXTENSIONS.has(extOf(abs))
            ? await fallbackMedia().probe(abs)
            : undefined;
          if (probe && !probe.hasVideo && !probe.hasAudio) {
            problem(source.id, rel, 'no_streams', 'No audio or video streams');
            skipped++;
            continue;
          }
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
              problem(source.id, rel, 'fingerprint_failed', error);
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
          let video: VideoDetails | undefined;
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
            problem(source.id, rel, 'tags_unreadable', error);
            skipped++;
            continue; // unreadable tags — skip the file, keep scanning
          }
          if (probe) {
            // Probe decides video-ness and backfills missing duration. An
            // audio-only .mp4 stays a song, and a streamless file is skipped.
            isVideo = probe.hasVideo;
            if (isVideo) {
              video = await videoDetails(
                abs,
                probe.audioStreams ?? [],
                probe.subtitleStreams ?? [],
              );
            }
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
            video,
            metadata,
            pictureHash: pictures[0]?.imageHash ?? null,
          };
          const localLyrics = await lyrics.sources(abs);
          file.scanFacts = {
            pictures,
            embeddedLyrics: localLyrics.filter((s) => s.origin === 'embedded'),
          };
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
          file.albumInput = albumInputs.get(file)!;
          files.push(file);
        } catch (error) {
          // Permission/mount races can happen after tags, while acquiring audio,
          // captions or lyrics too. Exclude the file at this one I/O boundary;
          // programming/service failures still fail the run atomically.
          if (
            !(error instanceof Deno.errors.PermissionDenied ||
              error instanceof Deno.errors.NotFound ||
              error instanceof Deno.errors.NotADirectory ||
              ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EIO', 'ESTALE']
                .includes(
                  (error as { code?: string }).code ?? '',
                ))
          ) throw error;
          problem(source.id, rel, 'tags_unreadable', error);
          skipped++;
        }
      }
    }
    availability.push({ id: source.id, available });
    progress.librariesDone++;
    report('walking');
  }

  const preserved = oldFiles.filter((f) =>
    !covered(coverage, f.libraryId, f.rel)
  );

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
      rows.filter((row) =>
        !seen.has(row.id) &&
        (covered(coverage, row.library_id, row.rel_path) ||
          (!scope.libraries && !scope.folder && !scope.scopes &&
            !sources.some((s) => s.id === row.library_id)))
      ),
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

  const allFiles = [...files, ...preserved];
  for (const file of allFiles) {
    albumInputs.set(file, file.albumInput!);
    const name = file.albumInput!.trackArtist;
    if (name !== null && file.artistId !== null) {
      artists.set(name, { id: file.artistId, name });
    }
  }
  const grouped = await groupAlbums(
    allFiles.map((f) => ({ ...albumInputs.get(f)!, songId: f.id })),
    sources,
    new Map(retained.map((r) => [r.id, r.album_id])),
    retainedAlbums,
  );
  for (const file of allFiles) file.albumId = grouped.fileAlbums.get(file.id)!;
  for (const album of grouped.albums) {
    if (album.artistName !== null) {
      artists.set(album.artistName, {
        id: album.albumArtistId!,
        name: album.artistName,
      });
    }
  }
  const artistMbids = artistMusicBrainzIds(allFiles.map((file) => ({
    ...albumInputs.get(file)!,
    metadata: file.metadata,
  })));
  report('publishing');
  const changedLibraries = await store.catalog.replaceCatalog({
    coverage,
    preserved,
    scanResult: { runId, startedAt, mode, libraries: availability, problems },
    sources: sources.map(({ id, path }) => ({ id, path })),
    artists: [...artists.values()].map((artist) => ({
      ...artist,
      musicBrainzId: artistMbids.get(artist.name) ?? null,
    })),
    albums: grouped.albums.map((album) => ({
      ...album,
      metadata: albumMetadata(
        allFiles.filter((file) => file.albumId === album.id),
      ),
    })),
    albumIdentities: grouped.identities,
    albumEvents: grouped.events,
    files,
    events,
    retainedIds: [...byId.keys()],
  });
  if (changedLibraries.length) {
    options.notify?.emit(['libraries'], { libraries: changedLibraries });
  }
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
    const versions = picturesByAlbum.get(album.id);
    // Local candidates are acquired only for completely observed albums.
    // An excluded track's picture/lyrics facts are not an empty observation.
    if (!versions || preserved.some((f) => f.albumId === album.id)) continue;
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
  for (const artist of artists.values()) {
    if (
      preserved.some((f) =>
        f.artistId === artist.id ||
        grouped.albums.some((a) =>
          a.id === f.albumId && a.albumArtistId === artist.id
        )
      )
    ) continue;
    const folder = await store.catalog.artistFolder(artist.id);
    const versions = new Map<string, LocalVersion>();
    if (folder) {
      for (const path of await artistImagePaths(folder.directory)) {
        const imageHashValue = await imageHash(await Deno.readFile(path));
        versions.set(imageHashValue, {
          imageHash: imageHashValue,
          imageExt: imageExtension(extOf(path).slice(1)),
          libraryId: folder.libraryId,
          origin: path.slice(
            sources.find((source) => source.id === folder.libraryId)!.path
              .length + 1,
          ),
        });
      }
    }
    await store.candidates.replaceLocal(
      artist.id,
      versions.size > 1 ? [...versions.values()] : [],
      'cover',
      'artist',
    );
  }
  return {
    files: allFiles.length,
    skipped,
    skippedByKind,
    artists: artists.size,
    albums: grouped.albums.length,
  };
}

export interface ScanProgress {
  phase: 'walking' | 'reading' | 'publishing';
  mode: ScanMode;
  scope: ScanSelection;
  librariesDone: number;
  librariesTotal: number;
  filesSeen: number;
  filesRead: number;
  problems: number;
  startedAt: string;
  elapsedMs: number;
}
export interface ScanRequest extends ScanScope {
  mode?: ScanMode;
}
export interface QueuedScan {
  mode: ScanMode;
  scope: ScanSelection;
}
export interface ScanStatus extends Partial<ScanProgress> {
  scanning: boolean;
  /** Files indexed by the last completed scan (0 before the first). */
  count: number;
  /** Configured sources (Navidrome's folderCount extra). */
  folderCount: number;
  /** Completion time of the last scan (Navidrome's lastScan extra). */
  lastScanMs: number | null;
  /** Start time of the latest scan, for conditional catalog reads. */
  lastScanStartedMs: number | null;
  lastError: string | null;
  queued: QueuedScan | null;
}
export interface ScanService {
  /** Foreground scan. Concurrent callers await the same result. */
  run(scope?: ScanRequest): Promise<ScanCounts>;
  request(scope?: ScanRequest): Promise<void>;
  problems(
    libraryId?: string,
  ): Promise<{ problems: ScanProblem[]; truncated: boolean }>;
  status(): Promise<ScanStatus>;
  /** Background entry point, sharing run's single-flight and logging failures. */
  start(
    options?: { afterCurrent?: boolean; ifRunning?: boolean },
  ): Promise<void>;
}

export function createScan(
  store: Store,
  media?: Media,
  opts?: {
    notify?: Notify;
    log?: Log;
    lyrics?: Lyrics;
    state?: State;
    tagReader?: () => TagReader;
  },
): ScanService {
  const log = opts?.log ?? scopedLog('scan');
  const state = opts?.state ?? createState(store);
  declareTagSettings(state);
  state.declare('scan.problemListLimit', {
    type: 'integer',
    default: 1000,
    minimum: 1,
    maximum: 1000,
  });
  state.declare('scan.progressIntervalMs', {
    type: 'integer',
    default: 1000,
    minimum: 1000,
    maximum: 2147483647,
  });
  let pending: Promise<ScanCounts> | null = null;
  let count = 0;
  let lastScanMs: number | null = null;
  let lastScanStartedMs: number | null = null;
  let lastError: string | null = null;
  let queued: QueuedScan | null = null;
  let progress: ScanProgress | null = null;
  let active = false;
  const enqueue = (request: QueuedScan) => {
    queued = queued
      ? {
        mode: queued.mode === 'full' || request.mode === 'full'
          ? 'full'
          : 'quick',
        scope: mergeScanScopes(queued.scope, request.scope),
      }
      : request;
  };
  const launch = (initial: QueuedScan): Promise<ScanCounts> => {
    if (pending !== null) return pending;
    pending = Promise.resolve().then(async () => {
      let request = initial;
      let counts: ScanCounts | undefined;
      for (;;) {
        lastScanStartedMs = Date.now();
        lastError = null;
        active = true;
        progress = {
          phase: 'walking',
          ...request,
          librariesDone: 0,
          librariesTotal: 0,
          filesSeen: 0,
          filesRead: 0,
          problems: 0,
          startedAt: new Date(lastScanStartedMs).toISOString(),
          elapsedMs: 0,
        };
        opts?.notify?.emit(['scan']);
        opts?.notify?.emit(['update']);
        let timer: ReturnType<typeof setInterval> | undefined;
        let failure: unknown;
        try {
          const interval = await state.getTyped(
            'scan.progressIntervalMs',
          ) as number;
          timer = setInterval(() => opts?.notify?.emit(['scan']), interval);
          counts = await scanLibrary(store, media, log, opts?.lyrics, {
            state,
            tagReader: opts?.tagReader?.(),
            selection: request.scope,
            mode: request.mode,
            startedAt: progress.startedAt,
            progress: (value) => {
              progress = value;
            },
            notify: opts?.notify,
          });
          count = counts.files;
          lastScanMs = Date.now();
          // Core emits after successful completion; hats just consume the event.
          opts?.notify?.emit(['database']);
        } catch (error) {
          // A source changed during I/O: the store refused the stale catalog.
          if (error instanceof LibrarySourcesChanged) {
            enqueue({ mode: request.mode, scope: {} });
          } else {
            lastError = error instanceof Error ? error.message : String(error);
            failure = error;
          }
        } finally {
          clearInterval(timer);
          active = false;
          if (progress) progress.elapsedMs = Date.now() - lastScanStartedMs!;
          opts?.notify?.emit(['scan']);
          opts?.notify?.emit(['update']);
        }
        if (queued === null) {
          if (failure) throw failure;
          return counts!;
        }
        if (failure) log.event('scan_failed', { error: failure });
        request = queued;
        queued = null;
      }
    }).finally(() => {
      pending = null;
    });
    return pending;
  };
  const run = (input: ScanRequest = {}): Promise<ScanCounts> => {
    if (pending !== null) return pending;
    const { mode = 'full', ...scope } = input;
    // Foreground callers retain their single-flight/full default contract.
    return launch({ scope, mode });
  };
  return {
    run,
    async request(input = {}) {
      const { mode = 'quick', ...scope } = input;
      if (mode !== 'quick' && mode !== 'full') {
        throw new LibraryError('invalid_field', 'Invalid scan mode');
      }
      const validated = await validateScanScope(
        scope,
        await store.catalog.listLibraries(),
      );
      const request = { scope: validated, mode };
      if (pending !== null) enqueue(request);
      else {void launch(request).catch((error) =>
          log.event('scan_failed', { error })
        );}
    },
    async problems(libraryId) {
      if (
        libraryId !== undefined &&
        !(await store.catalog.listLibraries()).some((l) => l.id === libraryId)
      ) {
        throw new LibraryError('not_found', 'Library not found');
      }
      return store.scan.problems(
        libraryId,
        await state.getTyped('scan.problemListLimit') as number,
      );
    },
    async status() {
      const folderCount = await store.catalog.libraryCount();
      return {
        ...structuredClone(progress ?? {}),
        ...(active && progress
          ? { elapsedMs: Date.now() - Date.parse(progress.startedAt) }
          : {}),
        scanning: active,
        count,
        folderCount,
        lastScanMs,
        lastScanStartedMs,
        lastError,
        queued: structuredClone(queued),
      };
    },
    async start(options = {}) {
      if (options.ifRunning && pending === null) return;
      if (options.afterCurrent && pending !== null) {
        enqueue({ mode: 'full', scope: {} });
      }
      try {
        await run();
      } catch (error) {
        log.event('scan_failed', { error });
      }
    },
  };
}
