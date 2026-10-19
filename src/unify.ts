// Core owns picture backups, integrity checks and atomic filesystem publication.
// Store slots never contain filesystem or media work.
import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { access } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type IAudioMetadata, parseFile } from 'music-metadata';
import type { Store } from './store/index.ts';
import type { Candidate, LocalVersion } from './store/candidates.ts';
import type { LookupJob } from './store/lookups.ts';
import {
  candidateImagePath,
  embeddedPictures,
  imageExtension,
  imageHash,
  isCoverFile,
  libraryImagesWritable,
  readCandidateImage,
  writeCandidateImage,
} from './images.ts';
import { createMedia } from './media.ts';
import { unchangedTagFacts, writeTags } from './tags.ts';
import {
  createLyrics,
  embeddedLyrics,
  lyricsHash,
  lyricsSidecars,
  type LyricsSource,
  readLyricsSidecar,
  serializeLyrics,
} from './lyrics.ts';

export type UnifyHandler = (
  job: LookupJob,
  signal: AbortSignal,
) => Promise<void>;

/** Resolve kept identities at execution, never store a stale absolute path in a job. */
export async function unifyTarget(store: Store, candidate: Candidate) {
  if (candidate.entityType !== 'album' || candidate.kind !== 'cover') {
    throw new Error('Not an album cover candidate');
  }
  const album = await store.catalog.getAlbum(candidate.entityId);
  if (!album?.songs.length) throw new Error('Candidate album is missing');
  const library = (await store.catalog.listLibraries()).find((row) =>
    row.id === album.songs[0].libraryId
  );
  if (
    !library || library.id !== candidate.libraryId ||
    !await libraryImagesWritable(library)
  ) {
    throw new Error('Candidate library is missing or read-only');
  }
  const dirs = await store.catalog.albumCoverDirectories(candidate.entityId);
  const trackDirs = new Set(album.songs.map((song) => dirname(song.path)));
  const directory = trackDirs.size === 1
    ? dirs[0]
    : dirs.find((dir) => !trackDirs.has(dir));
  if (!directory) {
    throw new Error('Multipart album has no exclusive cover folder');
  }
  return { album, library, dirs, directory };
}

async function covers(dirs: string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const dir of dirs) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && isCoverFile(entry.name)) {
        paths.push(`${dir}/${entry.name}`);
      }
    }
  }
  return paths.sort();
}

/** Local scan proposals reference live pictures until the first decision saves them. */
export async function materializeCandidate(store: Store, candidate: Candidate) {
  const target = await unifyTarget(store, candidate);
  let bytes = await readCandidateImage(
    target.library,
    candidate.imageHash,
    candidate.imageExt,
  );
  if (bytes === null && candidate.source === 'local') {
    for (const path of await covers(target.dirs)) {
      const image = await Deno.readFile(path);
      if (await imageHash(image) === candidate.imageHash) {
        bytes = image;
        break;
      }
    }
    if (bytes === null) {
      for (const song of target.album.songs) {
        for (
          const picture of embeddedPictures(await parseFile(song.path))
        ) {
          if (await imageHash(picture.data) === candidate.imageHash) {
            bytes = picture.data;
            break;
          }
        }
        if (bytes !== null) break;
      }
    }
  }
  if (bytes === null || await imageHash(bytes) !== candidate.imageHash) {
    throw new Error('Candidate image is missing or its hash differs');
  }
  if (!await writeCandidateImage(target.library, bytes, candidate.imageExt)) {
    throw new Error('Candidate library is read-only');
  }
  return {
    ...target,
    bytes,
    imagePath: candidateImagePath(
      target.library,
      candidate.imageHash,
      candidate.imageExt,
    ),
  };
}

/** Compare every parsed tag, including unknown/native tags, with pictures alone removed. */
function tagFacts(meta: IAudioMetadata) {
  return unchangedTagFacts(meta, { picture: true });
}

function signature(stat: Deno.FileInfo) {
  return [stat.dev, stat.ino, stat.size, stat.mtime?.getTime(), stat.mode];
}

async function inLibrary(path: string, root: string) {
  const realRoot = await Deno.realPath(root);
  const real = await Deno.realPath(path);
  if (
    real !== resolve(path) ||
    (real !== realRoot && !real.startsWith(`${realRoot}${sep}`))
  ) {
    throw new Error(`Path escapes library or is a symlink: ${path}`);
  }
}

async function syncFile(path: string) {
  using file = await Deno.open(path, { read: true });
  await file.sync();
}

/** A lyrics choice already contains its bounded text. Resolving it checks
 * current ownership and write permission without changing the filesystem. */
export async function materializeLyrics(store: Store, candidate: Candidate) {
  if (candidate.entityType !== 'song' || candidate.kind !== 'lyrics') {
    throw new Error('Not a song lyrics candidate');
  }
  const song = await store.catalog.getSong(candidate.entityId);
  if (!song) throw new Error('Candidate song is missing');
  const library = (await store.catalog.listLibraries()).find((l) =>
    l.id === song.libraryId
  );
  if (!library || library.id !== candidate.libraryId) {
    throw new Error('Candidate library is missing');
  }
  const source = candidate.details.lyrics as LyricsSource | undefined;
  if (
    !source?.entry || await lyricsHash(source.entry) !== candidate.imageHash
  ) throw new Error('Candidate lyrics are missing or their hash differs');
  await inLibrary(song.path, library.path);
  await access(library.path, constants.W_OK);
  await access(dirname(song.path), constants.W_OK);
  await access(song.path, constants.W_OK);
  return { song, library, entry: source.entry };
}

function nonLyricsTags(meta: IAudioMetadata) {
  return unchangedTagFacts(meta, { lyrics: true });
}

async function unifyLyrics(
  store: Store,
  candidate: Candidate,
  signal: AbortSignal,
  write: typeof writeTags,
) {
  const { song, library, entry } = await materializeLyrics(store, candidate);
  const beforeStat = signature(await Deno.stat(song.path));
  const beforeMeta = await parseFile(song.path);
  const lyrics = createLyrics(store);
  const limit = await lyrics.maxBytes();
  const text = serializeLyrics(entry);
  if (new TextEncoder().encode(text).length > limit) {
    throw new Error('Chosen lyrics exceed lyrics.maxBytes');
  }
  const media = createMedia();
  const before = await media.fingerprint(song.path);
  if (!before.fingerprint) throw new Error('No afp/1 fingerprint');
  const backup = async (source: LyricsSource | Omit<LyricsSource, 'entry'>) => {
    const hash = 'entry' in source
      ? await lyricsHash(source.entry)
      : await imageHash(new TextEncoder().encode(JSON.stringify(source)));
    await store.candidates.preserveLocal(song.id, [{
      libraryId: library.id,
      imageHash: hash,
      imageExt: 'lyrics',
      origin: source.origin === 'embedded'
        ? song.id
        : source.origin.slice(library.path.length + 1),
      details: { lyrics: source },
    }], 'lyrics');
  };
  // Preserve all native entries, even malformed ones that are not displayable.
  for (
    const tag of Object.values(beforeMeta.native).flat().filter((tag) =>
      /^(USLT|ULT|SYLT|LYRICS|©lyr)$/i.test(tag.id)
    )
  ) {
    const source =
      embeddedLyrics({ ...beforeMeta, native: { original: [tag] } })[0] ??
        { origin: 'embedded', native: tag };
    if (new TextEncoder().encode(JSON.stringify(source)).length > limit) {
      throw new Error('Original lyrics exceed lyrics.maxBytes');
    }
    await backup(source);
  }
  const snapshotSidecars = async () => {
    const stats = new Map<string, ReturnType<typeof signature>>();
    for (const path of await lyricsSidecars(song.path)) {
      await inLibrary(path, library.path);
      await access(path, constants.W_OK);
      const { bytes, entry, stat } = await readLyricsSidecar(path, limit);
      await backup({
        ...(entry ? { entry } : {}),
        origin: path,
        bytes: Buffer.from(bytes).toString('base64'),
      });
      stats.set(path, signature(stat));
    }
    return stats;
  };
  await snapshotSidecars();
  const temporary = `${dirname(song.path)}/.unify-${crypto.randomUUID()}`;
  const sideTemporary = `${dirname(song.path)}/.unify-${crypto.randomUUID()}`;
  const destination = song.path.slice(0, -extname(song.path).length) +
    (entry.synced ? '.lrc' : '.txt');
  const unchanged = async (
    path: string,
    expected?: ReturnType<typeof signature>,
  ) => {
    const current = await Deno.lstat(path).then(async (stat) => {
      await inLibrary(path, library.path);
      return signature(stat);
    }, (error) => {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    });
    if (!isDeepStrictEqual(current, expected)) {
      throw new Error(`File changed before lyrics publication: ${path}`);
    }
  };
  try {
    signal.throwIfAborted();
    (await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 }))
      .close();
    await Deno.copyFile(song.path, temporary);
    await write(temporary, {
      lyrics: {
        text,
        lang: entry.language,
        ...(entry.synced
          ? {
            synced: entry.lines.map((line) => ({
              timeMs: line.start!,
              text: `\n${line.text}`,
            })),
          }
          : {}),
      },
    }, signal);
    if (!isDeepStrictEqual(await media.fingerprint(temporary), before)) {
      throw new Error('Tag write changed afp/1 fingerprint');
    }
    const afterMeta = await parseFile(temporary);
    if (
      !isDeepStrictEqual(nonLyricsTags(afterMeta), nonLyricsTags(beforeMeta))
    ) throw new Error('Tag write changed a non-lyrics tag');
    if (
      !isDeepStrictEqual(
        embeddedLyrics(afterMeta).filter((source) =>
          (source.native as { id: string }).id !== 'SYLT'
        ).map((s) => s.entry),
        [entry],
      )
    ) throw new Error('Tag write did not embed the exact chosen lyrics');
    // Edits/additions made during tagging are also archived before replacement.
    const sideStats = await snapshotSidecars();
    const mode = (await Deno.stat(song.path)).mode! & 0o777;
    await Deno.chmod(temporary, mode);
    await syncFile(temporary);
    await Deno.writeTextFile(sideTemporary, text, {
      createNew: true,
      mode: 0o644,
    });
    await syncFile(sideTemporary);
    signal.throwIfAborted();
    const current = await store.candidates.byId(candidate.id);
    if (!current || current.state === 'rejected') {
      throw new Error('Lyrics choice was withdrawn');
    }
    await access(library.path, constants.W_OK);
    await access(song.path, constants.W_OK);
    await unchanged(song.path, beforeStat);
    await unchanged(destination, sideStats.get(destination));
    for (const [path, stat] of sideStats) await unchanged(path, stat);
    // Refuse an unbacked new sidecar instead of racing it out of existence.
    if (
      !isDeepStrictEqual(await lyricsSidecars(song.path), [...sideStats.keys()])
    ) throw new Error('Sidecars changed before lyrics publication');
    await Deno.rename(temporary, song.path);
    await Deno.rename(sideTemporary, destination);
    for (const [path, stat] of sideStats) {
      if (path === destination) continue;
      await unchanged(path, stat);
      await Deno.remove(path);
    }
    await syncFile(dirname(song.path));
    await store.candidates.setState(candidate.id, 'accepted');
  } finally {
    for (const path of [temporary, sideTemporary]) {
      await Deno.remove(path).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
}

export function createUnify(
  store: Store,
  options: { writeTags?: typeof writeTags } = {},
): UnifyHandler {
  const media = createMedia();
  const write = options.writeTags ?? writeTags;
  return async (job, signal) => {
    signal.throwIfAborted();
    const candidate = await store.candidates.byId(job.factsHash);
    if (!candidate || candidate.state === 'rejected') return;
    if (candidate.entityId !== job.entityId) {
      throw new Error('Unify job target differs');
    }
    if (candidate.kind === 'lyrics') {
      await unifyLyrics(
        store,
        candidate,
        signal,
        write,
      );
      return;
    }
    if (candidate.state !== 'accepted') return;
    const { album, library, dirs, directory, bytes } =
      await materializeCandidate(store, candidate);
    const coverPaths = await covers(dirs);
    const versions = new Map<string, LocalVersion>();
    const pending = new Map<string, LocalVersion>();
    const backup = async (data: Uint8Array, ext: string, origin: string) => {
      const hash = await imageHash(data);
      if (hash === candidate.imageHash || versions.has(hash)) return;
      const reference = await writeCandidateImage(library, data, ext);
      if (!reference) {
        throw new Error('Cannot back up picture in read-only library');
      }
      versions.set(hash, {
        imageHash: hash,
        imageExt: reference.ext,
        libraryId: library.id,
        origin,
      });
      pending.set(hash, versions.get(hash)!);
    };
    const persistBackups = async () => {
      if (!pending.size) return;
      await store.candidates.preserveLocal(album.album.id, [
        ...pending.values(),
      ]);
      pending.clear();
    };
    // Complete every backup before replacing the first picture. Retried jobs also
    // keep these archived candidates when scans reconcile the live conflict away.
    for (const song of album.songs) {
      try {
        signal.throwIfAborted();
        await inLibrary(song.path, library.path);
        for (
          const picture of embeddedPictures(await parseFile(song.path))
        ) {
          await backup(picture.data, imageExtension(picture.format), song.id);
        }
      } catch (error) {
        throw new Error(`${song.path}: ${error}`, { cause: error });
      }
    }
    for (const path of coverPaths) {
      await inLibrary(path, library.path);
      await backup(
        await Deno.readFile(path),
        path.slice(path.lastIndexOf('.') + 1),
        path.slice(library.path.length + 1),
      );
    }
    await persistBackups();
    for (const song of album.songs) {
      const temporary = `${dirname(song.path)}/.unify-${crypto.randomUUID()}`;
      try {
        signal.throwIfAborted();
        const beforeMeta = await parseFile(song.path);
        const pictures = embeddedPictures(beforeMeta);
        if (
          pictures.length === 1 &&
          await imageHash(pictures[0].data) === candidate.imageHash
        ) continue;
        // A long job can encounter a new local picture since its initial
        // snapshot. Save the current version too before replacing this track.
        for (const picture of pictures) {
          await backup(picture.data, imageExtension(picture.format), song.id);
        }
        await persistBackups();
        // Atomic rename is directory-authorized; explicitly honor an unwritable
        // original as well, rather than silently bypassing its permissions.
        await access(song.path, constants.W_OK);
        const beforeStat = await Deno.stat(song.path);
        const before = await media.fingerprint(song.path);
        if (!before.fingerprint) throw new Error('No afp/1 fingerprint');
        // Reserve a private same-folder file; no recognized media suffix, so a
        // concurrent scan cannot index an incomplete tag write.
        (await Deno.open(temporary, {
          createNew: true,
          write: true,
          mode: 0o600,
        })).close();
        await Deno.copyFile(song.path, temporary);
        const ext = imageExtension(candidate.imageExt);
        await write(temporary, {
          picture: { bytes, mime: `image/${ext === 'jpg' ? 'jpeg' : ext}` },
        }, signal);
        const after = await media.fingerprint(temporary);
        if (!isDeepStrictEqual(after, before)) {
          throw new Error('Tag write changed afp/1 fingerprint');
        }
        const afterMeta = await parseFile(temporary);
        if (!isDeepStrictEqual(tagFacts(afterMeta), tagFacts(beforeMeta))) {
          throw new Error('Tag write changed a non-picture tag');
        }
        if (
          afterMeta.common.picture?.length !== 1 ||
          await imageHash(afterMeta.common.picture[0].data) !==
            candidate.imageHash
        ) {
          throw new Error('Tag write did not embed the exact chosen picture');
        }
        signal.throwIfAborted();
        await inLibrary(song.path, library.path);
        if (
          !isDeepStrictEqual(
            signature(await Deno.stat(song.path)),
            signature(beforeStat),
          )
        ) {
          throw new Error('Track changed during tag write');
        }
        await Deno.chmod(temporary, beforeStat.mode! & 0o777);
        await syncFile(temporary);
        await access(library.path, constants.W_OK);
        await Deno.rename(temporary, song.path);
      } catch (error) {
        throw new Error(`${song.path}: ${error}`, { cause: error });
      } finally {
        await Deno.remove(temporary).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      }
    }
    signal.throwIfAborted();
    await inLibrary(directory, library.path);
    // Refresh at the publication boundary: covers may have been edited or
    // added while the tracks were being written. Nothing current is discarded.
    const currentCovers = await covers(dirs);
    const coverStats = new Map<string, ReturnType<typeof signature>>();
    for (const path of currentCovers) {
      await inLibrary(path, library.path);
      const observed = signature(await Deno.stat(path));
      await backup(
        await Deno.readFile(path),
        path.slice(path.lastIndexOf('.') + 1),
        path.slice(library.path.length + 1),
      );
      if (!isDeepStrictEqual(signature(await Deno.stat(path)), observed)) {
        throw new Error(`Cover changed during backup: ${path}`);
      }
      coverStats.set(path, observed);
    }
    await persistBackups();
    const destination = `${directory}/cover.${
      imageExtension(candidate.imageExt)
    }`;
    const temporary = `${directory}/.unify-${crypto.randomUUID()}`;
    try {
      await Deno.writeFile(temporary, bytes, { createNew: true, mode: 0o644 });
      await syncFile(temporary);
      signal.throwIfAborted();
      await access(library.path, constants.W_OK);
      const unchanged = async (path: string) => {
        const current = await Deno.stat(path).then(signature, (error) => {
          if (error instanceof Deno.errors.NotFound) return undefined;
          throw error;
        });
        if (!isDeepStrictEqual(current, coverStats.get(path))) {
          throw new Error(`Cover changed before replacement: ${path}`);
        }
      };
      await unchanged(destination);
      await Deno.rename(temporary, destination);
      for (const path of currentCovers) {
        if (path !== destination) {
          await unchanged(path);
          await Deno.remove(path);
        }
      }
    } finally {
      await Deno.remove(temporary).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  };
}
