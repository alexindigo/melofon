import { posix } from 'node:path';
import type { Library, SongMetadata, SongRow } from './types.ts';

export function librarySummary(library: Library) {
  return { id: library.id, name: library.name, available: library.available };
}

/** No absolute fallback, including unresolved or mismatched source roots. */
function relativeSongPath(song: SongRow): string | null {
  if (song.libraryPath === null || !posix.isAbsolute(song.libraryPath)) {
    return null;
  }
  if (!posix.isAbsolute(song.path)) return null;
  const path = posix.relative(song.libraryPath, song.path);
  return path === '' || path === '..' || path.startsWith('../') ||
      posix.isAbsolute(path)
    ? null
    : path;
}

// Explicit projection also keeps future internal metadata out of the wire DTO.
function indexedMetadata(metadata: SongMetadata) {
  return {
    bitRate: metadata.bitRate,
    bitDepth: metadata.bitDepth,
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
    trackGain: metadata.trackGain,
    trackPeak: metadata.trackPeak,
    albumGain: metadata.albumGain,
    albumPeak: metadata.albumPeak,
    baseGain: metadata.baseGain,
    recordingMbid: metadata.recordingMbid,
    artistMbid: metadata.artistMbid,
    albumArtistMbid: metadata.albumArtistMbid,
    isrc: metadata.isrc,
    genres: metadata.genres,
    moods: metadata.moods,
    comment: metadata.comment,
    sortTitle: metadata.sortTitle,
    artistSortName: metadata.artistSortName,
    albumArtistSortName: metadata.albumArtistSortName,
    bpm: metadata.bpm,
    explicit: metadata.explicit,
    discSubtitle: metadata.discSubtitle,
    albumMbid: metadata.albumMbid,
    recordLabels: metadata.recordLabels,
    releaseTypes: metadata.releaseTypes,
    releaseDate: metadata.releaseDate,
    originalReleaseDate: metadata.originalReleaseDate,
    compilation: metadata.compilation,
    version: metadata.version,
    albumSortName: metadata.albumSortName,
  };
}

export function songDetail(song: SongRow) {
  return {
    id: song.id,
    libraryId: song.libraryId,
    path: relativeSongPath(song),
    title: song.title,
    fileName: song.fileName,
    label: song.title ?? `[${song.fileName.replaceAll('_', ' ')}]`,
    albumId: song.albumId,
    albumName: song.albumName,
    albumFolderName: song.albumFolderName,
    albumLabel: song.albumName ??
      (song.albumFolderName === null ? null : `[${song.albumFolderName}]`),
    artistId: song.artistId,
    artistName: song.artistName,
    artistLabel: song.artistName ?? '[Unknown Artist]',
    track: song.track,
    disc: song.disc,
    durationMs: song.durationMs,
    size: song.size,
    genre: song.genre,
    year: song.year,
    firstSeenMs: song.firstSeenMs,
    isVideo: song.isVideo,
    suffix: song.suffix,
    contentType: song.contentType,
    metadata: song.metadata === undefined
      ? null
      : indexedMetadata(song.metadata),
  };
}
