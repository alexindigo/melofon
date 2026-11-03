import { posix } from 'node:path';
import type {
  AlbumRow,
  ArtistGroupRef,
  ArtistGroupRow,
  Library,
  MediaTrack,
  PlaylistRow,
  SongMetadata,
  SongRow,
  VideoDetails,
} from './types.ts';

// Reserved native IDs cannot collide with the catalog's hashed artist IDs.
export function artistReference(id: string): ArtistGroupRef {
  return id === 'various' || id === 'unknown'
    ? { kind: id }
    : { kind: 'artist', id };
}

export function artistSummary(artist: ArtistGroupRow) {
  return {
    id: artist.kind === 'artist' ? artist.id! : artist.kind,
    kind: artist.kind,
    name: artist.name,
    label: artist.name ??
      (artist.kind === 'various' ? '[Various Artists]' : '[Unknown Artist]'),
    musicBrainzId: artist.musicBrainzId,
    sortName: artist.sortName,
    albumCount: artist.albumCount,
  };
}

export function librarySummary(library: Library) {
  return { id: library.id, name: library.name, available: library.available };
}

export function playlistSummary(playlist: PlaylistRow) {
  return {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment,
    owner: playlist.owner,
    public: playlist.public,
    createdAtMs: playlist.createdAtMs,
    changedAtMs: playlist.changedAtMs,
    songCount: playlist.songCount,
    durationMs: playlist.durationMs,
  };
}

export function albumSummary(album: AlbumRow) {
  const metadata = album.metadata;
  return {
    id: album.id,
    name: album.name,
    label: album.name ?? `[${album.folderName}]`,
    folderName: album.folderName,
    artistId: album.artistId,
    artistName: album.artistName,
    artistKind: album.artistKind,
    artistLabel: album.artistName ??
      (album.artistKind === 'various'
        ? '[Various Artists]'
        : '[Unknown Artist]'),
    songCount: album.songCount,
    durationMs: album.durationMs,
    year: album.year,
    createdAtMs: album.createdAtMs,
    metadata: metadata === undefined ? null : {
      musicBrainzId: metadata.musicBrainzId,
      recordLabels: metadata.recordLabels,
      releaseTypes: metadata.releaseTypes,
      genres: metadata.genres,
      moods: metadata.moods,
      releaseDate: metadata.releaseDate,
      originalReleaseDate: metadata.originalReleaseDate,
      compilation: metadata.compilation,
      version: metadata.version,
      sortName: metadata.sortName,
      explicit: metadata.explicit,
      discTitles: metadata.discTitles.map(({ disc, title }) => ({
        disc,
        title,
      })),
    },
  };
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

function mediaTrack(track: MediaTrack) {
  return {
    index: track.index,
    codec: track.codec,
    language: track.language,
    title: track.title,
    ...(track.channels === undefined ? {} : { channels: track.channels }),
  };
}

export function videoDetail(song: SongRow, details: VideoDetails | null) {
  return {
    ...songDetail(song),
    details: videoFacts(details),
  };
}

/** One safe projection for browse details and playback discovery. */
export function videoFacts(details: VideoDetails | null) {
  return details === null ? null : {
    audio: details.audio.map(mediaTrack),
    subtitles: details.subtitles.map(mediaTrack),
    // Caption paths are internal resolution facts, never native payloads.
    captions: details.captions.map((caption) => ({
      key: caption.key,
      name: caption.name,
      format: caption.format,
      ...(caption.stream === undefined ? {} : { stream: caption.stream }),
    })),
  };
}
