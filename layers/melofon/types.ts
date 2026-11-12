// Structural ports only: hats never import core or its store.
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export type HatRequest = PathfinderRequest<Record<string, string>>;
export type ArtworkRef = {
  kind: 'song' | 'album' | 'artist' | 'playlist' | 'podcast' | 'radio';
  id: string;
};
export interface StationRow {
  id: string;
  name: string;
  streamUrl: string;
  homePageUrl: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}
export interface PodcastChannel {
  id: string;
  feedUrl: string;
  title: string | null;
  description: string | null;
  status: 'new' | 'completed' | 'error';
  lastRefreshMs: number | null;
}
export interface PodcastEpisode {
  id: string;
  channelId: string;
  title: string | null;
  description: string | null;
  publishDate: string | null;
  duration: number | null;
  status: 'new' | 'downloading' | 'completed' | 'error' | 'deleted' | 'skipped';
}
export interface ArtworkDescriptor {
  sourceHash: string;
  version: string;
  sourceKind:
    | 'embedded'
    | 'album-file'
    | 'album-candidate'
    | 'artist-photo'
    | 'playlist'
    | 'podcast'
    | 'radio-upload'
    | 'radio-stream'
    | 'radio-name';
  width: number | null;
  height: number | null;
  mime: string;
  thumbHash?: string | null;
  dominantColor?: string | null;
}
export type ArtworkDescription = { kind: 'unknown' | 'missing' } | {
  kind: 'image';
  descriptor: ArtworkDescriptor;
};
export type ArtworkSnapshot = { kind: 'unknown' } | { kind: 'missing' } | {
  kind: 'image';
  descriptor: ArtworkDescriptor;
  bytes: Uint8Array;
};
export type ArtworkPixels = { kind: 'unknown' | 'unavailable' } | {
  kind: 'pixels';
  descriptor: ArtworkDescriptor;
  width: number;
  height: number;
  rgba: Uint8Array;
};
export interface User {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: 'admin' | 'user';
  createdAt: string;
  lastLoginAt: string | null;
  lastAccessAt: string | null;
}
export interface Session {
  id: string;
  userId: string;
  deviceName: string;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
}
export interface PlaybackCapabilities {
  name: string;
  platform: string;
  maxAudioBitrate?: number;
  maxTranscodingAudioBitrate?: number;
  directPlayProfiles?: {
    containers: string[];
    audioCodecs: string[];
    protocols: string[];
    maxAudioChannels?: number;
  }[];
  transcodingProfiles?: {
    container: string;
    audioCodec: string;
    protocol: string;
    maxAudioChannels?: number;
  }[];
  codecProfiles?: {
    type: string;
    name: string;
    limitations?: {
      name: string;
      comparison: string;
      values: string[];
      required: boolean;
    }[];
  }[];
}
export interface Hat {
  name: string;
  state: 'found' | 'loaded' | 'active' | 'failed';
  active: boolean;
  pendingRestart: boolean;
  setup: boolean;
  errors: { phase: string; code: string; message: string; file?: string }[];
  mounts: { folder: string; prefix: string }[];
  ports: { claimed: number[]; actual: number[] };
  settings: string[];
}
export interface HatContext {
  meta: { jsonMaxBytesSetting?: string };
  app: {
    cfg: { dataDir?: string };
    speakers: {
      list(options?: { includeIgnored?: boolean }): SpeakerListEntry[];
      get(
        id: string,
        options?: { includeIgnored?: boolean },
      ): SpeakerListEntry | null;
      ignore(id: string): Promise<SpeakerListEntry>;
      unignore(id: string): Promise<void>;
      add(input: unknown, source?: Source): Promise<SpeakerView>;
      adopt(id: string): Promise<SpeakerView>;
      retry(id: string): Promise<SpeakerView>;
      setPassword(
        id: string,
        input: unknown,
      ): Promise<{ passwordSet: boolean }>;
      clearPassword(id: string): Promise<{ passwordSet: boolean }>;
      pair(id: string, input: unknown): Promise<SpeakerPairingView>;
      submitPin(id: string, input: unknown): Promise<SpeakerPairingView>;
      forget(id: string, source?: Source): Promise<void>;
      setVolume(
        id: string,
        volume: number,
        source?: Source,
      ): Promise<SpeakerView>;
      configure(
        id: string,
        input: unknown,
        source?: Source,
      ): Promise<SpeakerView>;
    };
    radio: {
      list(): Promise<StationRow[]>;
      get(id: string): Promise<StationRow | null>;
      artworkMaxBytes(): Promise<number>;
      putArtwork(id: string, bytes: Uint8Array): Promise<
        { ok: true } | { invalid: 'too_large' | 'invalid_image' } | null
      >;
      removeArtwork(id: string): Promise<boolean>;
    };
    podcasts: {
      channels(): Promise<PodcastChannel[]>;
      episodes(id: string): Promise<PodcastEpisode[]>;
      episode(id: string): Promise<PodcastEpisode | null>;
    };
    hatData: {
      get(key: string): Promise<{ kind: string; value: unknown } | null>;
      put(key: string, record: { kind: 'data'; value: unknown }): Promise<void>;
    };
    artwork: {
      pixels(
        ref: ArtworkRef,
        options: { username?: string; size: number },
      ): Promise<ArtworkPixels>;
      describe(
        ref: ArtworkRef,
        options?: { username?: string },
      ): Promise<ArtworkDescription>;
      snapshot(
        ref: ArtworkRef,
        options?: { username?: string },
      ): Promise<ArtworkSnapshot>;
      get(
        ref: string | ArtworkRef,
        options?: { username?: string; size?: number },
      ): Promise<
        { kind: 'unknown' } | { kind: 'placeholder'; response: Response } | {
          kind: 'image';
          descriptor: ArtworkDescriptor;
          rendition: 'original' | 'resized' | 'fallback';
          response: Response;
        }
      >;
    };
    media: {
      hls(
        path: string,
        root: string,
        options?: HlsOptions,
      ): Promise<HlsView | null>;
      hlsRenditions(
        path: string,
        root: string,
        options: HlsOptions[],
      ): Promise<HlsView[] | null>;
    };
    publicAddress: {
      prefix(): Promise<string>;
      acceptsOrigin(request: Request, origin: string): Promise<boolean>;
      secure(request: Request): Promise<boolean>;
    };
    clientQueue: {
      get(username: string): Promise<SavedQueue | null>;
      save(username: string, queue: {
        trackIds: string[];
        currentIndex?: number;
        positionMs?: number;
        changedBy?: string;
      }): Promise<void>;
    };
    plugins: {
      list(caller: string): Promise<{ plugins: Plugin[] }>;
      get(caller: string, id: string): Promise<PluginDetail>;
      change(caller: string, id: string, input: unknown): Promise<PluginDetail>;
    };
    preferences: {
      get(userId: string): Promise<Preferences>;
      change(
        userId: string,
        preferences: unknown,
        revisions?: unknown,
      ): Promise<Preferences>;
    };
    server: {
      get(caller: string): Promise<unknown>;
      log(caller: string, query: LogQuery): Promise<unknown>;
      logText(caller: string): Promise<string>;
      clearLog(caller: string): Promise<void>;
    };
    notify: {
      readonly bootId: string;
      subscribe(
        fn: (
          names: string[],
          ids: Record<string, string[]> | undefined,
          audience: 'all' | 'admins' | { userId: string },
        ) => void,
      ): () => void;
    };
    playback: {
      nowPlayingView(): Promise<NowPlayingViewRow[]>;
      reportSessionPlayback(report: SessionPlaybackReport): Promise<boolean>;
    };
    players: {
      list(): PlayerRow[];
      get(id: number): PlayerPlayback;
      create(name: string): Promise<PlayerRow>;
      rename(id: number, name: string): Promise<void>;
      delete(id: number): Promise<void>;
      setDefault(id: number): Promise<void>;
      members(id: number): { id: string; name: string; linked?: boolean }[];
      join(id: number, speakerId: string, source?: Source): Promise<void>;
      leave(id: number, speakerId: string, source?: Source): Promise<void>;
      setLinked(
        id: number,
        speakerId: string,
        linked: boolean,
        source?: Source,
      ): Promise<void>;
      copyQueue(id: number, targetId: number, options: {
        mode: 'replace' | 'add';
        where?: 'end' | 'next' | { position: number };
        startPlaying?: boolean;
        expectedVersion?: number;
      }, source?: Source): Promise<void>;
    };
    stream: {
      session(
        request: Request,
        file: { path: string; isVideo: boolean },
        caller: string,
        sessionId: string,
        options?: {
          format?: string;
          maxBitRateKbps?: number;
          timeOffset?: number;
        },
      ): Promise<Response>;
    };
    libraries: {
      stats(id: string): Promise<unknown>;
      list(): Promise<Library[]>;
      snapshot(): Promise<{ libraries: Library[]; revision: string }>;
      add(name: string, path: string, source?: Source): Promise<Library>;
      update(
        id: string,
        input: { name?: string; path?: string },
        source?: Source,
      ): Promise<Library>;
      remove(id: string, source?: Source): Promise<boolean>;
    };
    folders: {
      browse(options: FolderPageOptions): Promise<{
        folder: FolderRow | null;
        folders: { rows: FolderRow[]; total: number };
        songs: { rows: SongRow[]; total: number };
        revision: string;
      }>;
    };
    playlists: {
      visible(username: string): Promise<PlaylistRow[] | null | 'forbidden'>;
      get(
        username: string,
        id: string,
      ): Promise<(PlaylistRow & { trackIds: string[] }) | null>;
      containingSong(
        username: string,
        songId: string,
        options: PlaylistPageOptions,
      ): Promise<{ rows: PlaylistRow[]; total: number } | null>;
    };
    reference: {
      radio(
        id: string,
        count: number,
        username: string,
        options?: { type?: 'song' | 'album' | 'artist'; folderId?: string },
      ): Promise<string[] | null>;
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
      topTracks(
        id: string,
        count: number,
        username: string,
        folderId?: string,
      ): Promise<string[]>;
      similarArtists(
        id: string,
        count: number,
        presentOnly?: boolean,
        folderId?: string,
      ): Promise<(
        { present: true; id: string } | {
          present: false;
          name: string;
          mbid?: string;
        }
      )[]>;
    };
    library: {
      artistsPage(opts: ArtistPageOptions): Promise<{
        index?: CatalogIndexEntry[];
        rows: ArtistGroupRow[];
        total: number;
        revision: string;
      }>;
      order(): Promise<{ ignoredArticles: string[]; revision: number }>;
      getArtistSnapshot(ref: ArtistGroupRef, folderId?: string): Promise<{
        artist: ArtistGroupRow | null;
        revision: string;
      }>;
      artistAlbumsPage(ref: ArtistGroupRef, opts: ArtistPageOptions): Promise<{
        index?: CatalogIndexEntry[];
        artist: ArtistGroupRow | null;
        rows: AlbumRow[];
        total: number;
        revision: string;
      }>;
      albumsPage(opts: AlbumPageOptions): Promise<{
        index?: CatalogIndexEntry[];
        rows: AlbumRow[];
        total: number;
        revision: string;
      }>;
      getAlbumSnapshot(id: string, folderId?: string): Promise<{
        detail: { album: AlbumRow; songs: SongRow[] } | null;
        revision: string;
      }>;
      getSong(id: string): Promise<SongRow | null>;
      lyricsBySongId(id: string): Promise<LyricsEntry[]>;
      getSongSnapshot(
        id: string,
      ): Promise<{ song: SongRow | null; revision: string }>;
      songsPage(opts: SongPageOptions): Promise<{
        index?: CatalogIndexEntry[];
        rows: SongRow[];
        total: number;
        revision: string;
      }>;
      videosPage(opts: ArtistPageOptions): Promise<{
        rows: SongRow[];
        total: number;
        revision: string;
      }>;
      getVideoSnapshot(id: string, folderId?: string): Promise<{
        detail: { song: SongRow; details: VideoDetails | null } | null;
        revision: string;
      }>;
      caption(videoId: string, selection: {
        key: string;
        format: 'srt' | 'vtt';
      }): Promise<{ text: string; format: 'srt' | 'vtt' } | null>;
      searchPages(query: string, opts: SearchPageOptions): Promise<{
        artists: { rows: ArtistGroupRow[]; total: number };
        albums: { rows: AlbumRow[]; total: number };
        songs: { rows: SongRow[]; total: number };
        revision: string;
      }>;
      genresPage(opts: GenrePageOptions): Promise<{
        rows: GenreRow[];
        total: number;
        revision: string;
      }>;
      statistics(folderId?: string): Promise<{
        statistics: CatalogStatistics;
        revision: string;
      }>;
    };
    scan: {
      start(): Promise<void>;
      request(
        scope?: {
          libraries?: string[];
          folder?: { library: string; path: string };
          mode?: 'quick' | 'full';
        },
      ): Promise<void>;
      problems(libraryId?: string): Promise<unknown>;
      status(): Promise<ScanStatus>;
    };
    settings: {
      describe(caller: string, key?: string): Promise<Setting[]>;
      change(caller: string, changes: unknown): Promise<Setting[]>;
    };
    hats: {
      list(caller: string): Promise<{ hats: Hat[]; restartRequired: boolean }>;
      rescan(
        caller: string,
      ): Promise<{ hats: Hat[]; restartRequired: boolean }>;
      activate(caller: string, name: string): Promise<Hat>;
      deactivate(caller: string, name: string): Promise<Hat>;
    };
    state: { getTyped(key: string): Promise<unknown> };
    signIn(input: {
      username: string;
      password: string;
      clientAddress: string;
      deviceName: string;
      userAgent: string;
    }): Promise<{ session: Session; key: string }>;
    sessions: {
      playbackCapabilities(
        caller: string,
        sessionId: string,
      ): Promise<PlaybackCapabilities | null>;
      replacePlaybackCapabilities(
        caller: string,
        sessionId: string,
        input: unknown,
      ): Promise<PlaybackCapabilities>;
      authenticate(
        key: string,
        options?: { touch?: boolean },
      ): Promise<{ user: User; sessionId: string } | null>;
      onSessionsEnded(
        fn: (event: {
          userId: string;
          sessionIds: string[];
        }) => void,
      ): () => void;
      list(caller: string, target?: string): Promise<Session[]>;
      revoke(caller: string, id: string): Promise<void>;
      revokeAll(caller: string, target?: string): Promise<void>;
    };
    users: {
      get(caller: string, target: string): Promise<User>;
      list(caller: string): Promise<User[]>;
      create(caller: string, input: {
        username: string;
        password: string;
        role: 'admin' | 'user';
        displayName?: string;
        email?: string;
      }): Promise<User>;
      update(caller: string, target: string, input: {
        username?: string;
        displayName?: string | null;
        email?: string | null;
        role?: 'admin' | 'user';
      }): Promise<User>;
      setPassword(
        caller: string,
        target: string,
        input: { current?: string; new: string },
      ): Promise<void>;
      noteAccess(id: string): Promise<void>;
    };
  };
  state: {
    user: User;
    sessionId: string;
    json: Record<string, unknown>;
  };
  miss?: unknown;
}

export interface SessionPlaybackReport {
  userId: string;
  sessionId: string;
  trackId: string;
  /** Positive increasing counter per login, including repeats of a song. */
  run: number;
  /** Nonnegative increasing counter within the run; reuse on retry. */
  sequence: number;
  state: 'starting' | 'playing' | 'paused' | 'stopped';
  positionMs: number;
  playbackRate: number;
  ignoreScrobble: boolean;
}

export interface SpeakerPairingView {
  state:
    | 'preparing'
    | 'awaiting_pin'
    | 'pairing'
    | 'complete'
    | 'failed'
    | 'cancelled';
  saved: boolean;
  error?: { code: string; message: string };
}

export interface SpeakerView {
  ignored?: true;
  adopted: boolean;
  discovered: boolean;
  id: string;
  name: string;
  protocol: string;
  address?: string;
  port?: number;
  model?: string;
  selected: boolean;
  playerId: number | null;
  linked: boolean;
  volume: number;
  connectionStrategy: 'melofon' | 'owntone' | 'audiostation';
  abilities: {
    volume: boolean;
    seek: boolean;
    pin: boolean;
    password: boolean;
    formats: string[];
  } | null;
  state: {
    connection: 'disconnected' | 'connecting' | 'connected' | 'failed';
    authentication: 'none' | 'authentication_required';
    pairing?: SpeakerPairingView;
    error?: { code: string; message: string };
    preparation: {
      state: 'unresolved' | 'preparing' | 'ready' | 'failed';
      targetRevision: number;
      source?: string;
      expiresAt?: number;
      error?: { code: string; message: string };
    };
  };
}

export type SpeakerListEntry = SpeakerView | {
  id: string;
  ignored: true;
  adopted: false;
  discovered: false;
};

export interface SavedQueue {
  trackIds: string[];
  currentIndex: number;
  positionMs: number;
  changedAtMs: number;
  changedBy: string | null;
}

export type NowPlayingViewRow =
  & {
    positionMs: number | null;
    startedAtMs: number | null;
    reportedAtMs: number;
    state: 'starting' | 'playing' | 'paused';
    playbackRate: number;
  }
  & (
    | { facts: { kind: 'song'; song: SongRow } }
    | {
      reference: { kind: 'station'; id: string } | { kind: 'url'; url: string };
      facts: {
        kind: 'web';
        title: string | null;
        artistName: string | null;
        durationMs: number | null;
        mode: 'live' | 'finite' | 'unknown';
        seekable: boolean;
        streamTitle: string | null;
      };
    }
  )
  & (
    | { kind: 'app'; username: string; client: string; appPlayerId: number }
    | {
      kind: 'server';
      playerId: number;
      playerName: string;
      label: string;
      commander: string | null;
      speakers: { id: string; name: string }[];
    }
  );

export interface PlayerRow {
  id: number;
  name: string;
  isDefault: boolean;
}

export interface PlayerPlayback {
  queueRemove(
    entryId: number,
    expectedVersion?: number,
    source?: Source,
  ): void | Promise<void>;
  queueMove(
    entryId: number,
    position: number,
    expectedVersion?: number,
    source?: Source,
  ): void;
  queueClear(source?: Source, expectedVersion?: number): void;
  queueAddReferences(
    references: PlayerQueueReference[],
    options: {
      where?: 'end' | 'next' | { position: number };
      clear?: boolean;
      startPlaying?: boolean;
    },
    source?: Source,
  ): Promise<PlayerQueueEntry[]>;
  queueView(): { version: number; items: PlayerQueueEntry[] };
  queuePageView(options: {
    view: 'upNext' | 'all';
    offset: number;
    limit: number;
  }): {
    version: number;
    currentEntryId: number | null;
    startIndex: number;
    total: number;
    items: PlayerQueueEntry[];
  };
  play(source?: Source): void | Promise<void>;
  pause(source?: Source): void;
  stop(source?: Source): void;
  next(source?: Source): void | Promise<void>;
  previous(source?: Source): void | Promise<void>;
  restart(source?: Source): void | Promise<void>;
  seek(
    options: { positionMs?: number; seekMs?: number },
    source?: Source,
  ): boolean | Promise<boolean>;
  setRepeat(mode: 'off' | 'all' | 'single', source?: Source): void;
  setConsume(on: boolean, source?: Source): void;
  setVolume(options: { volume: number }, source?: Source): Promise<void>;
  playerView(): {
    state: 'play' | 'pause' | 'stop';
    repeat: 'off' | 'all' | 'single';
    consume: boolean;
    shuffle: boolean;
    volume: number;
    itemLengthMs: number;
    itemProgressMs: number;
    capabilities: { live: boolean; seekable: boolean };
  };
  serverNowPlayingView():
    | (Extract<NowPlayingViewRow, { kind: 'server' }> & {
      entryId: number;
    })
    | null;
}

export type PlayerQueueReference =
  | { kind: 'song'; id: string }
  | { kind: 'station'; id: string }
  | { kind: 'album'; id: string }
  | { kind: 'artist'; id: string }
  | { kind: 'playlist'; id: string }
  | { kind: 'folder'; libraryId: string; path: string }
  | { kind: 'url'; url: string };

export type PlayerQueueEntry =
  & { id: number }
  & (
    | {
      reference: { kind: 'song'; id: string };
      facts: { kind: 'song'; song: SongRow };
    }
    | {
      reference: { kind: 'station'; id: string } | { kind: 'url'; url: string };
      facts: Extract<NowPlayingViewRow, { facts: { kind: 'web' } }>['facts'];
    }
  );

export interface Setting {
  key: string;
  owner: string;
  category: string;
  schema: Record<string, unknown>;
  default?: unknown;
  value?: unknown;
  source: 'stored' | 'default';
  revision: number;
  writeOnly: boolean;
  isSet?: boolean;
  invalid?: true;
}
export interface Plugin {
  id: string;
  name: string;
  version?: string;
  origin: 'builtin' | 'override';
  state:
    | 'discovered'
    | 'disabled'
    | 'starting'
    | 'ready'
    | 'failed'
    | 'stopping';
  error?: string;
  capabilities: {
    id: string;
    accepts: string;
    provides: string[];
    requires: string[];
  }[];
  network: {
    requestedHosts: { host: string; reason?: string; ratePerMinute?: number }[];
    approvedHosts: string[];
  };
  settingKeys: string[];
  discovery: 'startup';
}
export interface PluginDetail extends Plugin {
  enabled: boolean;
  hosts: string[];
  settings: {
    schema: {
      type: 'object';
      properties: Record<string, Record<string, unknown>>;
    };
    values: Record<string, unknown>;
    revisions: Record<string, number>;
  };
}
export interface Preferences {
  preferences: Record<string, unknown>;
  revisions: Record<string, number>;
  defaults: Record<string, unknown>;
}
export interface LogQuery {
  after?: number;
  level?: 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'fatal';
  component?: string;
  limit: number;
}

export interface Library {
  id: string;
  name: string;
  path: string;
  available: boolean;
}
export interface SongMetadata {
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
  isrc: string[];
  genres: string[];
  moods: string[];
  comment: string | null;
  sortTitle: string | null;
  artistSortName: string | null;
  albumArtistSortName: string | null;
  bpm: number | null;
  explicit: 'explicit' | 'clean' | null;
  discSubtitle: string | null;
  albumMbid: string | null;
  recordLabels: string[];
  releaseTypes: string[];
  releaseDate: string | null;
  originalReleaseDate: string | null;
  compilation: boolean;
  version: string | null;
  albumSortName: string | null;
}
export interface BrowsePageOptions {
  articleRevision?: number;
  ignoredArticles?: string[];
  natural?: boolean;
  sortTags?: boolean;
  descending?: boolean;
  index?: boolean;
  sort: 'name' | 'artist' | 'year' | 'newest' | 'genre' | 'random';
  seed?: string;
  offset: number;
  limit: number;
  folderId?: string;
  genre?: string;
  fromYear?: number;
  toYear?: number;
}
export interface FolderRow {
  libraryId: string;
  path: string;
  name: string;
}
export interface PlaylistPageOptions {
  articleRevision?: number;
  ignoredArticles?: string[];
  offset: number;
  limit: number;
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
export interface FolderPageOptions {
  articleRevision?: number;
  libraryId?: string;
  path?: string;
  ignoredArticles?: string[];
  folders: { offset: number; limit: number };
  songs: { offset: number; limit: number };
}
export interface AlbumPageOptions extends Omit<BrowsePageOptions, 'sort'> {
  sort:
    | BrowsePageOptions['sort']
    | 'starred'
    | 'highest'
    | 'frequent'
    | 'recent';
  username?: string;
}
export type SongPageOptions = BrowsePageOptions;
export type ArtistGroupRef =
  | { kind: 'artist'; id: string }
  | { kind: 'various' | 'unknown' };
export interface ArtistGroupRow {
  kind: 'artist' | 'various' | 'unknown';
  id: string | null;
  name: string | null;
  musicBrainzId: string | null;
  sortName: string | null;
  albumCount: number;
}
export interface ArtistPageOptions {
  articleRevision?: number;
  ignoredArticles?: string[];
  natural?: boolean;
  sortTags?: boolean;
  descending?: boolean;
  index?: boolean;
  folderId?: string;
  offset: number;
  limit: number;
}
export type GenrePageOptions = ArtistPageOptions;
export interface SearchPageOptions {
  articleRevision?: number;
  ignoredArticles?: string[];
  natural?: boolean;
  sortTags?: boolean;
  folderId?: string;
  artists: { offset: number; limit: number };
  albums: { offset: number; limit: number };
  songs: { offset: number; limit: number };
}
export interface CatalogIndexEntry {
  initial: string | null;
  kind: 'text' | 'unknown' | 'various';
  offset: number;
  count: number;
}
export interface GenreRow {
  name: string;
  songCount: number;
  albumCount: number;
}
export interface CatalogStatistics {
  songCount: number;
  videoCount: number;
  durationMs: number;
  albumCount: number;
  artistCount: number;
  browseArtistCount: number;
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
  createdAtMs: number | null;
  metadata?: {
    musicBrainzId: string | null;
    recordLabels: string[];
    releaseTypes: string[];
    genres: string[];
    moods: string[];
    releaseDate: string | null;
    originalReleaseDate: string | null;
    compilation: boolean;
    version: string | null;
    sortName: string | null;
    explicit: 'explicit' | 'clean' | null;
    discTitles: { disc: number; title: string }[];
  };
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
  metadata?: SongMetadata;
}
export interface MediaTrack {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
  channels?: number;
}
export interface HlsOptions {
  kbps?: number;
  width?: number;
  height?: number;
  audioTrack?: number;
}
export interface HlsView {
  width: number;
  height: number;
  bandwidth: number;
  complete: boolean;
  segments: { duration: number }[];
  segment(index: number): Promise<ReadableStream<Uint8Array> | null>;
  release(): Promise<void>;
}
export interface LyricsCue {
  start: number;
  end?: number;
  text: string;
  byteStart: number;
  byteEnd: number;
}
export interface LyricsEntry {
  language: string;
  synced: boolean;
  offset?: number;
  artist?: string;
  title?: string;
  lines: { start?: number; text: string; cues?: LyricsCue[] }[];
}
export interface VideoDetails {
  audio: MediaTrack[];
  subtitles: MediaTrack[];
  captions: {
    key: string;
    name: string;
    format: 'srt' | 'vtt';
    stream?: number;
  }[];
}
export interface Source {
  kind: 'http';
  peer?: string;
  userAgent?: string;
  user?: string;
  via?: string;
}
export interface ScanStatus {
  scanning: boolean;
  count: number;
  folderCount: number;
  lastScanMs: number | null;
  lastScanStartedMs: number | null;
  lastError: string | null;
}
