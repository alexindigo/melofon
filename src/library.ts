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

export interface Library
  extends
    Omit<CatalogReads, 'songForLyrics' | 'coverSongPath' | 'albumSongPath'> {
  /** Embedded (USLT) lyrics of the best artist/title match. */
  lyrics(query: { artist?: string; title?: string }): Promise<LyricsRow | null>;
  /** Embedded (APIC) cover of an album's first song, or of a song id itself. */
  embeddedCover(
    id: string,
  ): Promise<{ bytes: Uint8Array; format: string } | null>;
  /** Absolute path of an album's cover.jpg, for app.artwork (null if none). */
  albumCoverPath(id: string): Promise<string | null>;
}

export function createLibrary(store: Store): Library {
  const catalog = store.catalog;
  return {
    listArtists: catalog.listArtists,
    getArtist: catalog.getArtist,
    artistById: catalog.artistById,
    albumsByArtist: catalog.albumsByArtist,
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
      const path = await catalog.albumSongPath(id);
      if (path === null) return null;
      const dir = path.slice(0, path.lastIndexOf('/'));
      const cover = `${dir}/cover.jpg`;
      try {
        const stat = await Deno.stat(cover);
        return stat.isFile ? cover : null;
      } catch {
        return null;
      }
    },
  };
}
