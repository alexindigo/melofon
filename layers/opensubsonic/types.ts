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

export interface LyricsEntryRow {
  language: string;
  synced: boolean;
  offset?: number;
  artist?: string;
  title?: string;
  lines: {
    start?: number;
    text: string;
    cues?: {
      start: number;
      end?: number;
      text: string;
      byteStart: number;
      byteEnd: number;
    }[];
  }[];
}

export interface HatRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  method: string;
  headers: Headers;
  body: {
    form(): Promise<FormData>;
    json(): Promise<unknown>;
  };
  _raw: Request;
}

export interface HatContext {
  app: {
    publicAddress: { full(request: Request, path: string): Promise<string> };
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
      get(
        caller: string,
        username: string,
      ): Promise<UserProfile | null | 'forbidden'>;
      list(caller: string): Promise<UserProfile[] | 'forbidden'>;
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
    /** Read-only local reference projection; refresh scheduling belongs to core. */
    reference: {
      get(
        type: 'artist',
        id: string,
        names:
          readonly ('artist.biography' | 'artist.url' | 'artist.id.mbid')[],
      ): Promise<{
        'artist.biography'?: { text: string; language?: string };
        'artist.url'?: { url: string };
        'artist.id.mbid'?: string;
      }>;
      artistByName(name: string): Promise<string | null>;
      topTracks(id: string, count: number, user: string): Promise<string[]>;
      radio(id: string, count: number, user: string): Promise<string[] | null>;
      similarArtists(
        id: string,
        count: number,
        presentOnly?: boolean,
      ): Promise<(
        { present: true; id: string } | {
          present: false;
          name: string;
          mbid?: string;
        }
      )[]>;
    };
    scan: {
      status(): Promise<ScanStatusRow>;
      /** Background scan; resolves when done (the op does not await it). */
      start(): Promise<void>;
    };
    library: {
      order(): Promise<{ ignoredArticles: string[]; revision: number }>;
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
      videos(folderId?: string): Promise<SongRow[]>;
      videoDetails(id: string): Promise<
        {
          audio: {
            index: number;
            codec: string | null;
            language: string | null;
            title: string | null;
          }[];
          captions: { key: string; name: string }[];
        } | null
      >;
      caption(
        videoId: string,
        options?: { key?: string; format?: 'srt' | 'vtt' },
      ): Promise<{ text: string; format: 'srt' | 'vtt' } | null>;
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
      lyricsBySongId(id: string): Promise<LyricsEntryRow[]>;
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
      visible(
        username: string,
        forUsername?: string,
      ): Promise<PlaylistRow[] | null | 'forbidden'>;
      get(username: string, id: string): Promise<PlaylistWithTracks | null>;
      create(
        username: string,
        name: string,
        trackIds: string[],
        public_?: boolean,
      ): Promise<PlaylistWithTracks>;
      setTracks(
        username: string,
        id: string,
        trackIds: string[],
        public_?: boolean,
      ): Promise<PlaylistWithTracks | null | 'forbidden'>;
      update(
        username: string,
        id: string,
        opts: {
          name?: string;
          comment?: string;
          public?: boolean;
          addTrackIds?: string[];
          removeAtPositions?: number[];
        },
      ): Promise<PlaylistWithTracks | null | 'forbidden'>;
      delete(username: string, id: string): Promise<boolean | 'forbidden'>;
    };
    radio: {
      list(): Promise<StationRow[]>;
      create(input: StationInput): Promise<StationResult>;
      update(
        id: string,
        input: StationInput,
      ): Promise<StationResult | null>;
      delete(id: string): Promise<boolean>;
    };
    shares: {
      enabled(): Promise<boolean>;
      publicUrl(): Promise<string>;
      create(
        owner: string,
        ids: string[],
        options: ShareOptions,
      ): Promise<ShareRow | 'disabled' | null | { invalid: string }>;
      list(caller: string): Promise<ShareRow[]>;
      update(
        caller: string,
        id: string,
        options: ShareOptions,
      ): Promise<ShareRow | 'forbidden' | null | { invalid: string }>;
      delete(caller: string, id: string): Promise<boolean | 'forbidden'>;
      contents(
        share: ShareRow,
      ): Promise<{ albums: AlbumRow[]; tracks: SongRow[] }>;
    };
    podcasts: {
      channels(): Promise<PodcastChannelRow[]>;
      episodes(channelId: string): Promise<PodcastEpisodeRow[]>;
      newest(count: number): Promise<PodcastEpisodeRow[]>;
      episode(id: string): Promise<PodcastEpisodeRow | null>;
      addChannel(url: string): Promise<PodcastChannelRow>;
      refresh(): Promise<void>;
      download(id: string): Promise<PodcastEpisodeRow | null>;
      deleteChannel(id: string): Promise<boolean>;
      deleteEpisode(id: string): Promise<boolean>;
    };
    clientQueue: {
      get(username: string): Promise<PlayQueueRow | null>;
      save(
        username: string,
        queue: {
          trackIds: string[];
          currentIndex?: number;
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
      reportPlayback(report: {
        source: 'opensubsonic';
        username: string;
        client: string;
        trackId: string;
        state: 'starting' | 'playing' | 'paused' | 'stopped';
        positionMs: number;
        playbackRate: number;
        ignoreScrobble: boolean;
      }): Promise<boolean>;
      nowPlayingView(): Promise<NowPlayingViewRow[]>;
    };
    stream: {
      source(
        id: string,
      ): Promise<{ path: string; isVideo: boolean; trackId?: string } | null>;
      file(
        request: Request,
        path: string,
      ): Promise<Response>;
      play(
        request: Request,
        file: { path: string; isVideo: boolean },
        format?: string,
        maxBitRateKbps?: number,
        options?: { timeOffset?: number; estimateContentLength?: boolean },
      ): Promise<Response | null>;
      decision(
        file: { path: string; isVideo: boolean },
        capabilities: import('./transcoding.ts').ClientInfo,
        username: string,
        intent?: 'audio' | 'video',
      ): Promise<import('./transcoding.ts').TranscodeDecision | null>;
      negotiated(
        request: Request,
        file: { path: string; isVideo: boolean },
        token: string,
        username: string,
        offset?: number,
      ): Promise<Response>;
    };
    media: {
      hlsRenditions(
        path: string,
        cacheRoot: string,
        options: import('./hls.ts').HlsOptions[],
      ): Promise<
        {
          width: number;
          height: number;
          bandwidth: number;
          complete: boolean;
          segments: { duration: number }[];
          segment(index: number): Promise<ReadableStream<Uint8Array> | null>;
          release(): Promise<void>;
        }[] | null
      >;
      hls(path: string, cacheRoot: string, options?: {
        kbps?: number;
        width?: number;
        height?: number;
        audioTrack?: number;
      }): Promise<
        {
          width: number;
          height: number;
          bandwidth: number;
          complete: boolean;
          segments: { duration: number }[];
          segment(index: number): Promise<ReadableStream<Uint8Array> | null>;
          release(): Promise<void>;
        } | null
      >;
    };
    zip: {
      archive(entries: { name: string; path: string }[]): Promise<Blob>;
    };
    artwork: {
      hasArtistPhoto(id: string): Promise<boolean>;
      get(id: string, options?: { size?: number; username?: string }): Promise<
        { kind: 'unknown' } | {
          kind: 'image' | 'placeholder';
          response: Response;
        }
      >;
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
export interface ShareOptions {
  description?: string;
  expires?: number;
}
export interface ShareRow {
  id: string;
  owner: string;
  description: string;
  resourceType: 'song' | 'album' | 'artist' | 'playlist';
  resourceIds: string[];
  downloadable: boolean;
  expiresAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  lastVisitedAtMs: number | null;
  visitCount: number;
}
export type PodcastStatus =
  | 'new'
  | 'downloading'
  | 'completed'
  | 'error'
  | 'deleted'
  | 'skipped';
export interface PodcastChannelRow {
  id: string;
  feedUrl: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  imagePath: string | null;
  status: PodcastStatus;
  errorMessage: string | null;
}
export interface PodcastEpisodeRow {
  id: string;
  channelId: string;
  title: string | null;
  description: string | null;
  publishDate: string | null;
  duration: number | null;
  contentType: string | null;
  filePath: string | null;
  size: number | null;
  status: PodcastStatus;
  streamId?: string;
}

export interface StationInput {
  name: string;
  streamUrl: string;
  homePageUrl: string | null;
}
export interface StationRow extends StationInput {
  id: string;
}
export type StationResult = StationRow | { invalid: string };

export interface LibraryFolderRow {
  id: string;
  name: string;
  path: string;
}

export interface ArtistRow {
  id: string;
  name: string;
  musicBrainzId?: string | null;
  albumCount: number;
  sortKey?: string;
}

export interface AlbumRow {
  metadata?: {
    musicBrainzId: string | null;
    recordLabels: string[] | null;
    releaseTypes: string[] | null;
    genres: string[] | null;
    moods: string[] | null;
    releaseDate: string | null;
    originalReleaseDate: string | null;
    compilation: boolean | null;
    version: string | null;
    sortName: string | null;
    explicit: string | null;
    discTitles: { disc: number; title: string }[] | null;
  };
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
  pictureHash?: string | null;
  metadata?: {
    bitRate: number | null;
    bitDepth: number | null;
    sampleRate: number | null;
    channels: number | null;
    trackGain: number | null;
    trackPeak: number | null;
    albumGain: number | null;
    albumPeak: number | null;
    baseGain: number | null;
    recordingMbid: string | null;
    artistMbid: string | null;
    albumArtistMbid: string | null;
    isrc: string[] | null;
    genres: string[] | null;
    moods: string[] | null;
    comment: string | null;
    sortTitle: string | null;
    bpm: number | null;
    explicit: string | null;
  };
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

export interface UserProfile {
  username: string;
  role: 'admin' | 'user';
}

export interface PlaylistRow {
  id: string;
  name: string;
  comment: string | null;
  owner: string;
  public: boolean;
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
  currentIndex: number;
  positionMs: number;
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

export interface LyricsRow {
  artist: string | null;
  title: string | null;
  text: string;
}

/** app.playback.nowPlayingView() row: a now-playing entry with the song
 * already resolved by core (client rows plus the engine's current). */
interface NowPlayingFacts {
  positionMs: number | null;
  startedAtMs: number | null;
  reportedAtMs: number;
  state: 'starting' | 'playing' | 'paused';
  playbackRate: number;
}

export type NowPlayingViewRow =
  & NowPlayingFacts
  & (
    | { facts: { kind: 'song'; song: SongRow } }
    | { facts: { kind: 'web' } }
  )
  & (
    | { kind: 'app'; username: string; client: string; appPlayerId: number }
    | {
      kind: 'server';
      label: string;
      commander: string | null;
      speakers: { id: string; name: string }[];
    }
  );
