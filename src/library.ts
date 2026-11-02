// app.library keeps filesystem/tag work outside the store's exclusive queue.
import { boundedMetadata } from './lyrics-metadata.ts';
import { createMedia, type Media } from './media.ts';
import { convertCaptions } from './video.ts';
import type { Store } from './store/index.ts';
import type { CatalogReads, LyricsRow } from './store/catalog.ts';
import { createLyrics, type Lyrics, type LyricsEntry } from './lyrics.ts';
import { type CatalogOrder, createCatalogOrder } from './catalog-order.ts';
import { createState, type State } from './state.ts';
import type { Notify } from './notify.ts';
import {
  artistImagePaths,
  embeddedPictures,
  imageContentType,
  isCoverFile,
  readCandidateImage,
  readImage,
} from './images.ts';
export type {
  AlbumPageOptions,
  AlbumRow,
  ArtistGroupRef,
  ArtistGroupRow,
  ArtistPageOptions,
  ArtistRow,
  CatalogIndexEntry,
  CatalogStatistics,
  GenrePageOptions,
  GenreRow,
  LyricsRow,
  NamePageOptions,
  RandomSongOptions,
  Search3Result,
  SearchPageOptions,
  SearchPages,
  SongPageOptions,
  SongRow,
} from './store/catalog.ts';

export interface Library extends
  Omit<
    CatalogReads,
    | 'songsForLyrics'
    | 'songForLyrics'
    | 'coverSongPath'
    | 'albumSongPath'
    | 'albumCoverDirectories'
  > {
  /** Shared browse policy, with a revision for conditional representations. */
  order(): Promise<CatalogOrder>;
  /** Lyrics of the bounded best artist/title match, from the shared service. */
  lyrics(query: { artist?: string; title?: string }): Promise<LyricsRow | null>;
  lyricsBySongId(id: string): Promise<LyricsEntry[]>;
  caption(
    videoId: string,
    options?: { key?: string; format?: 'srt' | 'vtt' },
  ): Promise<{ text: string; format: 'srt' | 'vtt' } | null>;
  /** Embedded (APIC) cover of an album's first song, or of a song id itself. */
  embeddedCover(
    id: string,
    maxBytes?: number,
  ): Promise<{ bytes: Uint8Array; format: string } | null>;
  /** Absolute path of cover.{jpg,jpeg,png,webp} in album folder/root. */
  albumCoverPath(id: string): Promise<string | null>;
  /** Strong open album proposal, resolved outside the store slot. */
  candidateCover(
    id: string,
    maxBytes?: number,
  ): Promise<{ bytes: Uint8Array; format: string } | null>;
  artistPhoto(
    id: string,
    maxBytes?: number,
  ): Promise<{ bytes: Uint8Array; format: string } | null>;
  artistPhotoMissing(id: string): Promise<boolean>;
}

export function createLibrary(
  store: Store,
  lyrics: Lyrics = createLyrics(store),
  options: { dataDir?: string; media?: Media; state?: State; notify?: Notify } =
    {},
): Library {
  const catalog = store.catalog;
  const localArtistPath = async (id: string) => {
    const folder = await catalog.artistFolder(id);
    return folder
      ? (await artistImagePaths(folder.directory))[0] ?? null
      : null;
  };
  return {
    order: createCatalogOrder(
      options.state ?? createState(store),
      options.notify,
    ),
    artistFolder: catalog.artistFolder,
    videoDetails: catalog.videoDetails,
    async caption(videoId, selection = {}) {
      const details = await catalog.videoDetails(videoId);
      if (!details) return null;
      const source = selection.key !== undefined
        ? details.captions.find((c) => c.key === selection.key)
        : details.captions[0];
      if (!source) return null;
      const format = selection.format ?? source.format;
      try {
        if (source.file) {
          const text = await Deno.readTextFile(source.file);
          return {
            text: source.format === format
              ? text
              : convertCaptions(text, format),
            format,
          };
        }
        const path = await catalog.songPath(videoId);
        if (!path || source.stream === undefined) return null;
        const text = await (options.media ?? createMedia()).captions(
          path,
          source.stream,
          format,
        );
        return text === null ? null : { text, format };
      } catch {
        return null;
      }
    },
    async artistPhotoMissing(id) {
      return !await localArtistPath(id) &&
        !await store.candidates.acceptedArtistPhoto(id);
    },
    async artistPhoto(id, maxBytes = Infinity) {
      const local = await localArtistPath(id);
      if (local) {
        try {
          const bytes = await readImage(local, maxBytes);
          if (bytes) {
            return { bytes, format: imageContentType(local.split('.').pop()!) };
          }
        } catch { /* A vanished local picture falls through. */ }
      }
      const candidate = await store.candidates.acceptedArtistPhoto(id) ??
        await store.candidates.strongestOpen('artist', id, 'cover');
      if (!candidate || !options.dataDir) return null;
      const bytes = await readCandidateImage(
        { path: options.dataDir },
        candidate.imageHash,
        candidate.imageExt,
        maxBytes,
      );
      return bytes
        ? { bytes, format: imageContentType(candidate.imageExt) }
        : null;
    },
    listArtists: catalog.listArtists,
    artistsPage: catalog.artistsPage,
    getArtistSnapshot: catalog.getArtistSnapshot,
    artistAlbumsPage: catalog.artistAlbumsPage,
    getArtist: catalog.getArtist,
    artistById: catalog.artistById,
    artistIds: catalog.artistIds,
    albumsByArtist: catalog.albumsByArtist,
    albumsWithoutArtist: catalog.albumsWithoutArtist,
    listAlbums: catalog.listAlbums,
    albumsById: catalog.albumsById,
    getAlbum: catalog.getAlbum,
    albumsPage: catalog.albumsPage,
    getAlbumSnapshot: catalog.getAlbumSnapshot,
    getSong: catalog.getSong,
    getSongSnapshot: catalog.getSongSnapshot,
    songsPage: catalog.songsPage,
    search3: catalog.search3,
    searchPages: catalog.searchPages,
    songPath: catalog.songPath,
    videos: catalog.videos,
    videosPage: catalog.videosPage,
    getVideoSnapshot: catalog.getVideoSnapshot,
    randomSongs: catalog.randomSongs,
    listSongs: catalog.listSongs,
    listGenres: catalog.listGenres,
    genresPage: catalog.genresPage,
    statistics: catalog.statistics,
    songsByGenre: catalog.songsByGenre,
    lyrics: lyrics.legacy,
    lyricsBySongId: lyrics.bySongId,
    async embeddedCover(id, maxBytes = Infinity) {
      const path = await catalog.coverSongPath(id);
      if (path === null) return null;
      try {
        const meta = await boundedMetadata(path, maxBytes, { duration: false });
        const picture = embeddedPictures(meta)[0];
        if (!picture) return null;
        return { bytes: picture.data, format: picture.format };
      } catch {
        return null; // unreadable file — treated as no embedded cover
      }
    },
    async albumCoverPath(id) {
      const dirs = await catalog.albumCoverDirectories(id);
      for (const dir of dirs) {
        try {
          const names: string[] = [];
          for await (const entry of Deno.readDir(dir)) {
            if (
              entry.isFile && isCoverFile(entry.name)
            ) {
              names.push(entry.name);
            }
          }
          // Conflicts are proposals only, so the displayed local choice stays stable.
          names.sort();
          if (names.length > 0) return `${dir}/${names[0]}`;
        } catch {
          // Missing/unreadable folder: try the remaining eligible directories.
        }
      }
      return null;
    },
    async candidateCover(id, maxBytes) {
      const candidate = await store.candidates.strongestOpen(
        'album',
        id,
        'cover',
      );
      if (candidate === null) return null;
      const library = (await catalog.listLibraries()).find((l) =>
        l.id === candidate.libraryId
      );
      if (!library) return null;
      const bytes = await readCandidateImage(
        library,
        candidate.imageHash,
        candidate.imageExt,
        maxBytes,
      );
      return bytes === null
        ? null
        : { bytes, format: imageContentType(candidate.imageExt) };
    },
  };
}
