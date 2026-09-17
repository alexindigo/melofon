// layers/opensubsonic/types.ts — the opensubsonic hat's structural types.
// This module lives at the layer root, outside the walked mount tree
// (layers/opensubsonic/rest/): shared code, not routes. The hat is
// self-sufficient: no src/ imports — core injects the service bag declared
// here on context.app.

export interface StateUser {
  username: string;
  displayName: string;
}

export interface HatRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  method: string;
  headers: Headers;
  body: {
    form(): Promise<FormData>;
  };
  _raw: Request;
}

export interface HatContext {
  app: {
    cfg: {
      version?: string;
    };
    user: {
      auth(username: string, password: string): Promise<StateUser | null>;
      authMd5(
        username: string,
        token: string,
        salt: string,
      ): Promise<StateUser | null>;
    };
    libraries: {
      list(): Promise<LibraryFolderRow[]>;
    };
    scan: {
      status(): Promise<ScanStatusRow>;
      /** Background scan; resolves when done (the op does not await it). */
      start(): Promise<void>;
    };
    library: {
      listArtists(folderId?: string): Promise<ArtistRow[]>;
      getArtist(id: string): Promise<ArtistRow | null>;
      albumsByArtist(artistId: string): Promise<AlbumRow[]>;
      listAlbums(opts: {
        sort:
          | 'name'
          | 'artist'
          | 'random'
          | 'newest'
          | 'starred'
          | 'highest'
          | 'frequent'
          | 'recent'
          | 'genre'
          | 'year';
        size: number;
        offset: number;
        folderId?: string;
        genre?: string;
        username?: string;
        fromYear?: number;
        toYear?: number;
      }): Promise<AlbumRow[]>;
      getAlbum(
        id: string,
      ): Promise<{ album: AlbumRow; songs: SongRow[] } | null>;
      getSong(id: string): Promise<SongRow | null>;
      search3(
        query: string,
        opts: {
          artistCount: number;
          artistOffset: number;
          albumCount: number;
          albumOffset: number;
          songCount: number;
          songOffset: number;
          folderId?: string;
        },
      ): Promise<
        { artists: ArtistRow[]; albums: AlbumRow[]; songs: SongRow[] }
      >;
      /** Absolute path of a song's audio file (null when unknown). */
      songPath(id: string): Promise<string | null>;
      /** All music videos in the catalog (getVideos). */
      videos(): Promise<SongRow[]>;
      /** Random songs from the catalog (getRandomSongs pull-forward). */
      randomSongs(size: number, folderId?: string): Promise<SongRow[]>;
      listGenres(): Promise<GenreRow[]>;
      songsByGenre(
        genre: string,
        opts: { size: number; offset: number; folderId?: string },
      ): Promise<SongRow[]>;
      lyrics(query: {
        artist?: string;
        title?: string;
      }): Promise<LyricsRow | null>;
    };
    annotation: {
      star(
        username: string,
        targetId: string,
        targetType: string,
      ): Promise<void>;
      unstar(
        username: string,
        targetId: string,
        targetType: string,
      ): Promise<void>;
      /** Subsonic 1..5; 0 clears. */
      setRating(
        username: string,
        targetId: string,
        rating: number,
      ): Promise<void>;
      starred(username: string): Promise<StarredRow[]>;
    };
    listens: {
      record(
        username: string,
        trackId: string,
        opts: {
          source: string;
          playedAtMs?: number;
          durationMs?: number;
        },
      ): Promise<void>;
    };
    playlists: {
      list(username: string): Promise<PlaylistRow[]>;
      get(username: string, id: string): Promise<PlaylistWithTracks | null>;
      create(
        username: string,
        name: string,
        trackIds: string[],
      ): Promise<PlaylistWithTracks>;
      setTracks(
        username: string,
        id: string,
        trackIds: string[],
      ): Promise<PlaylistWithTracks | null>;
      update(
        username: string,
        id: string,
        opts: {
          name?: string;
          comment?: string;
          addTrackIds?: string[];
          removeAtPositions?: number[];
        },
      ): Promise<PlaylistWithTracks | null>;
      delete(username: string, id: string): Promise<boolean>;
    };
    clientQueue: {
      get(username: string): Promise<PlayQueueRow | null>;
      save(
        username: string,
        queue: {
          trackIds: string[];
          currentId?: string;
          positionMs?: number;
        },
      ): Promise<void>;
    };
    bookmarks: {
      list(username: string): Promise<BookmarkRow[]>;
      set(
        username: string,
        trackId: string,
        positionMs: number,
        comment?: string,
      ): Promise<void>;
      remove(username: string, trackId: string): Promise<void>;
    };
    nowPlaying: {
      set(
        username: string,
        client: string,
        trackId: string,
        positionMs?: number,
      ): Promise<void>;
      list(): Promise<NowPlayingRow[]>;
    };
    stream: {
      file(request: Request, path: string): Promise<Response>;
      play(
        request: Request,
        file: { path: string; isVideo: boolean },
        format?: string,
      ): Promise<Response | null>;
    };
    zip: {
      archive(entries: { name: string; path: string }[]): Promise<Blob>;
    };
    artwork: {
      cover(id: string): Promise<Response>;
      placeholder(): Response;
    };
  };
  state: {
    user?: StateUser;
    params?: URLSearchParams;
  };
}

// Domain rows, declared structurally (the hat does not import src/).
export interface LibraryFolderRow {
  id: string;
  name: string;
  path: string;
}

export interface ArtistRow {
  id: string;
  name: string;
  albumCount: number;
}

export interface AlbumRow {
  id: string;
  name: string;
  artistId: string;
  artistName: string;
  songCount: number;
  durationMs: number;
  year: number | null;
  /** Newest file mtime on the album (null only when it has no files). */
  createdAtMs: number | null;
}

export interface SongRow {
  id: string;
  path: string;
  libraryId: string | null;
  libraryPath: string | null;
  title: string;
  albumId: string | null;
  albumName: string | null;
  artistId: string | null;
  artistName: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
  size: number | null;
  genre: string | null;
  year: number | null;
  isVideo: boolean;
  suffix: string;
  contentType: string;
}

export interface GenreRow {
  name: string;
  songCount: number;
  albumCount: number;
}

export interface StarredRow {
  targetId: string;
  targetType: string; // 'song' | 'album' | 'artist'
  starredAtMs: number; // epoch milliseconds
}

export interface PlaylistRow {
  id: string;
  name: string;
  comment: string | null;
  createdAtMs: number;
  changedAtMs: number;
  songCount: number;
  durationMs: number;
}

export interface PlaylistWithTracks extends PlaylistRow {
  trackIds: string[];
}

export interface PlayQueueRow {
  trackIds: string[];
  currentId: string | null;
  positionMs: number | null;
  changedAtMs: number;
}

export interface ScanStatusRow {
  scanning: boolean;
  count: number;
  folderCount: number;
  lastScanMs: number | null;
}

export interface BookmarkRow {
  trackId: string;
  positionMs: number;
  comment: string | null;
  createdAtMs: number;
  changedAtMs: number;
}

export interface LyricsRow {
  artist: string | null;
  title: string | null;
  text: string;
}

export interface NowPlayingRow {
  username: string;
  client: string;
  trackId: string;
  positionMs: number | null;
  startedAtMs: number;
}
