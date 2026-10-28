// Structural ports only: hats never import core or its store.
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export type HatRequest = PathfinderRequest<Record<string, string>>;
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
    library: {
      albumsPage(opts: AlbumPageOptions): Promise<{
        rows: AlbumRow[];
        total: number;
        revision: string;
      }>;
      getAlbumSnapshot(id: string, folderId?: string): Promise<{
        detail: { album: AlbumRow; songs: SongRow[] } | null;
        revision: string;
      }>;
      getSong(id: string): Promise<SongRow | null>;
      getSongSnapshot(
        id: string,
      ): Promise<{ song: SongRow | null; revision: string }>;
      songsPage(opts: SongPageOptions): Promise<{
        rows: SongRow[];
        total: number;
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

export interface SavedQueue {
  trackIds: string[];
  currentIndex: number;
  positionMs: number;
  changedAtMs: number;
  changedBy: string | null;
}

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
  sort: 'name' | 'artist' | 'year' | 'newest' | 'genre';
  offset: number;
  limit: number;
  folderId?: string;
  genre?: string;
  fromYear?: number;
  toYear?: number;
}
export type AlbumPageOptions = BrowsePageOptions;
export type SongPageOptions = BrowsePageOptions;
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
