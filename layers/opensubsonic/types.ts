// layers/opensubsonic/types.ts — the opensubsonic hat's structural types.
// This module lives at the layer root, outside the walked mount tree
// (layers/opensubsonic/rest/): shared code, not routes. The hat is
// self-sufficient: no src/ imports — core injects the service bag declared
// here on context.app.

export interface StateUser {
  username: string;
  displayName: string;
}

/** How this request's envelopes render (resolved once by 10-auth). */
export type ResponseFormat =
  | { type: 'xml' }
  | { type: 'json' }
  | { type: 'jsonp'; callback: string };

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
      /** Data dir root — the HLS segment cache lives under it. */
      dataDir?: string;
    };
    /** Operator-owned live config (`opensubsonic.jsonp`). */
    state: {
      get(key: string): Promise<string | null>;
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
      listArtists(
        folderId?: string,
        opts?: { ignoredArticles?: string[] },
      ): Promise<ArtistRow[]>;
      getArtist(id: string): Promise<ArtistRow | null>;
      artistById(id: string): Promise<ArtistRow | null>;
      albumsByArtist(artistId: string): Promise<AlbumRow[]>;
      albumsWithoutArtist(
        kind: 'various' | 'unknown',
        opts?: { folderId?: string },
      ): Promise<AlbumRow[]>;
      listAlbums(opts: {
        sort:
          | 'name'
          | 'artist'
          | 'random'
          | 'newest'
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
        ignoredArticles?: string[];
        fromYear?: number;
        toYear?: number;
      }): Promise<AlbumRow[]>;
      /** The given albums (unknown skipped), by id; folder-scoped counts. */
      albumsById(
        ids: string[],
        opts: { folderId?: string },
      ): Promise<AlbumRow[]>;
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
      randomSongs(
        opts: {
          size: number;
          folderId?: string;
          genre?: string;
          fromYear?: number;
          toYear?: number;
        },
      ): Promise<SongRow[]>;
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
      /** Appends a star (a like); core classifies the id. false when the id
       * is no artist, album or song (nothing written). */
      star(username: string, targetId: string): Promise<boolean>;
      /** Appends an unstar (also for ids that left the catalog); false when
       * there is nothing to unstar. */
      unstar(username: string, targetId: string): Promise<boolean>;
      /** Subsonic 1..5; 0 clears. false when the id is unknown. */
      setRating(
        username: string,
        targetId: string,
        rating: number,
      ): Promise<boolean>;
      /** Starred-now items that still exist, with their raw events. */
      starred(
        username: string,
        opts?: { folderId?: string },
      ): Promise<StarredItem[]>;
      /** Batch facts; every requested id is present. */
      facts(
        username: string,
        targetIds: string[],
      ): Promise<Record<string, PersonalFactsRow>>;
    };
    listens: {
      /** false when the track is not a catalog file (nothing written). */
      record(
        username: string,
        trackId: string,
        opts: {
          source: string;
          playedAtMs?: number;
          durationMs?: number;
        },
      ): Promise<boolean>;
      /** Batch play facts; every requested id is present. */
      facts(
        username: string,
        ids: { songs?: string[]; albums?: string[]; artists?: string[] },
      ): Promise<{
        songs: Record<string, PlayRow>;
        albums: Record<string, PlayRow>;
        artists: Record<string, PlayRow>;
      }>;
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
          changedBy?: string;
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
    playback: {
      /** THE playback core the hat calls: report a client play/stop (the
       * session table is core's), read the shared now-playing view. The hat
       * never merges stores and never touches the session table itself. */
      reportPlaying(report: {
        username: string;
        client: string;
        trackId: string;
        streamId: string;
        positionMs?: number;
      }): Promise<void>;
      reportStopped(opts: { streamId: string }): Promise<void>;
      nowPlayingView(): Promise<NowPlayingViewRow[]>;
    };
    stream: {
      file(
        request: Request,
        path: string,
        identity?: StreamIdentity,
      ): Promise<Response>;
      play(
        request: Request,
        file: { path: string; isVideo: boolean },
        format?: string,
        identity?: StreamIdentity,
        maxBitRateKbps?: number,
      ): Promise<Response | null>;
    };
    media: {
      /** Remux to 10s MPEG-TS HLS segments in outDir (stream copy);
       *  null when the file is not remuxable or the mux fails. */
      hlsRemux(path: string, outDir: string): Promise<number | null>;
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
    format?: ResponseFormat;
    /** Routed operation name (`stream`, `hls.m3u8`, …). */
    operation?: string;
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
  sortKey?: string;
}

export interface AlbumRow {
  id: string;
  name: string | null;
  artistId: string | null;
  artistName: string | null;
  artistKind: 'tagged' | 'shared' | 'various' | 'unknown';
  folderName: string;
  songCount: number;
  durationMs: number;
  year: number | null;
  /** Earliest first observation among the album's listed files. */
  createdAtMs: number | null;
}

export interface SongRow {
  id: string;
  path: string;
  libraryId: string | null;
  libraryPath: string | null;
  title: string | null;
  fileName: string;
  albumId: string | null;
  albumName: string | null;
  albumFolderName: string | null;
  artistId: string | null;
  artistName: string | null;
  track: number | null;
  disc: number | null;
  durationMs: number | null;
  size: number | null;
  genre: string | null;
  year: number | null;
  firstSeenMs: number | null;
  isVideo: boolean;
  suffix: string;
  contentType: string;
}

export interface GenreRow {
  name: string;
  songCount: number;
  albumCount: number;
}

/** One star-history event (core appends, never overwrites). */
export interface StarEvent {
  action: 'star' | 'unstar';
  atMs: number; // epoch milliseconds
}

export interface StarredItem {
  targetId: string;
  targetType: 'song' | 'album' | 'artist';
  /** This user's events for the item, ascending (oldest first). */
  events: StarEvent[];
}

export interface PersonalFactsRow {
  /** The latest event is a star. */
  starred: boolean;
  /** This user's events for the item, ascending (oldest first). */
  events: StarEvent[];
  userRating: number | null;
  /** Unrounded average over all users' ratings. */
  averageRating: number | null;
}

export interface PlayRow {
  playCount: number;
  lastPlayedMs: number | null;
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
  /** Name of the client that saved the queue (null on pre-M4.5 rows). */
  changedBy: string | null;
}

export interface ScanStatusRow {
  scanning: boolean;
  count: number;
  folderCount: number;
  lastScanMs: number | null;
  lastScanStartedMs: number | null;
}

export interface BookmarkRow {
  trackId: string;
  positionMs: number;
  comment: string | null;
  createdAtMs: number;
  changedAtMs: number;
}

/** One id per stream open (each Range hit mints its own) — core hooks
 * start/complete into playback.reportPlaying/reportStopped. */
export interface StreamIdentity {
  username: string;
  client: string;
  trackId: string;
  streamId: string;
}

export interface LyricsRow {
  artist: string | null;
  title: string | null;
  text: string;
}

/** app.playback.nowPlayingView() row: a now-playing entry with the song
 * already resolved by core (client rows plus the engine's current). */
export interface NowPlayingViewRow {
  username: string;
  client: string;
  song: SongRow;
  positionMs: number | null;
  startedAtMs: number;
}
