// app.library keeps filesystem/tag work outside the store's exclusive queue.
import { parseFile } from 'music-metadata';
import type { Store } from './store/index.ts';
import type { CatalogReads, LyricsRow } from './store/catalog.ts';
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
    | 'songForLyrics'
    | 'coverSongPath'
    | 'albumSongPath'
    | 'albumCoverDirectories'
  > {
  /** Embedded (USLT) lyrics of the best artist/title match. */
  lyrics(query: { artist?: string; title?: string }): Promise<LyricsRow | null>;
  /** Embedded (APIC) cover of an album's first song, or of a song id itself. */
  embeddedCover(
    id: string,
  ): Promise<{ bytes: Uint8Array; format: string } | null>;
  /** Absolute path of cover.{jpg,jpeg,png,webp} in album folder/root. */
  albumCoverPath(id: string): Promise<string | null>;
}

export function createLibrary(store: Store): Library {
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
    async lyrics(query) {
      const song = await catalog.songForLyrics(query);
      if (!song) return null;
      let text: string | undefined;
      try {
        const meta = await parseFile(song.path);
        text = meta.common.lyrics?.[0]?.text?.trim() || undefined;
      } catch {
        return null; // unreadable file — treated as no lyrics
      }
      if (text === undefined) return null;
      return { artist: song.artistName, title: song.title, text };
    },
    async embeddedCover(id) {
      const path = await catalog.coverSongPath(id);
      if (path === null) return null;
      try {
        const meta = await parseFile(path);
        const picture = meta.common.picture?.[0];
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
              entry.isFile && /^cover\.(jpg|jpeg|png|webp)$/i.test(entry.name)
            ) {
              names.push(entry.name);
            }
          }
          // Stable selection until local conflicts become candidates (L3).
          names.sort();
          if (names.length > 0) return `${dir}/${names[0]}`;
        } catch {
          // Missing/unreadable folder: try the remaining eligible directories.
        }
      }
      return null;
    },
  };
}
