// app.library keeps filesystem/tag work outside the store's exclusive queue.
import { parseFile } from 'music-metadata';
import type { Store } from './store/index.ts';
import type { CatalogReads, LyricsRow } from './store/catalog.ts';
import { createLyrics, type Lyrics, type LyricsEntry } from './lyrics.ts';
import {
  embeddedPictures,
  imageContentType,
  isCoverFile,
  readCandidateImage,
} from './images.ts';
export type {
  AlbumRow,
  ArtistRow,
  GenreRow,
  LyricsRow,
  RandomSongOptions,
  Search3Result,
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
  /** Lyrics of the bounded best artist/title match, from the shared service. */
  lyrics(query: { artist?: string; title?: string }): Promise<LyricsRow | null>;
  lyricsBySongId(id: string): Promise<LyricsEntry[]>;
  /** Embedded (APIC) cover of an album's first song, or of a song id itself. */
  embeddedCover(
    id: string,
  ): Promise<{ bytes: Uint8Array; format: string } | null>;
  /** Absolute path of cover.{jpg,jpeg,png,webp} in album folder/root. */
  albumCoverPath(id: string): Promise<string | null>;
  /** Strong open album proposal, resolved outside the store slot. */
  candidateCover(
    id: string,
  ): Promise<{ bytes: Uint8Array; format: string } | null>;
}

export function createLibrary(
  store: Store,
  lyrics: Lyrics = createLyrics(store),
): Library {
  const catalog = store.catalog;
  return {
    listArtists: catalog.listArtists,
    getArtist: catalog.getArtist,
    artistById: catalog.artistById,
    albumsByArtist: catalog.albumsByArtist,
    albumsWithoutArtist: catalog.albumsWithoutArtist,
    listAlbums: catalog.listAlbums,
    albumsById: catalog.albumsById,
    getAlbum: catalog.getAlbum,
    getSong: catalog.getSong,
    search3: catalog.search3,
    songPath: catalog.songPath,
    videos: catalog.videos,
    randomSongs: catalog.randomSongs,
    listSongs: catalog.listSongs,
    listGenres: catalog.listGenres,
    songsByGenre: catalog.songsByGenre,
    lyrics: lyrics.legacy,
    lyricsBySongId: lyrics.bySongId,
    async embeddedCover(id) {
      const path = await catalog.coverSongPath(id);
      if (path === null) return null;
      try {
        const meta = await parseFile(path);
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
    async candidateCover(id) {
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
      );
      return bytes === null
        ? null
        : { bytes, format: imageContentType(candidate.imageExt) };
    },
  };
}
