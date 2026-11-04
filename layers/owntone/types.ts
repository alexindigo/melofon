// layers/owntone/types.ts — the owntone hat's structural types. This module
// lives at the layer root, outside the walked mount tree
// (layers/owntone/api/): shared code, not routes. The hat is self-sufficient:
// no src/ imports, no other hat's modules — core injects the service bag
// declared here on context.app.

/** Provenance for a mutating command (plan command-provenance) — the
 * structural mirror of core's CommandSource (hats never import src/). */
export interface CommandSourceRow {
  kind: 'http' | 'internal';
  via?: string;
  peer?: string;
  userAgent?: string;
  user?: string;
  /** X-Melofon-Client when the caller names itself — a Melofon header,
   * never an OwnTone wire field (plan command-provenance-wire-fix). */
  client?: string;
}

/** The last recorded engine mutation — /api/player's last_command. */
export interface LastCommandRow {
  kind: string;
  detail?: string;
  source: CommandSourceRow;
  atMs: number;
}

export interface HatRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  method: string;
  headers: Headers;
  /** The connection peer (pathfinder surfaces it from Deno.serve's info) —
   * provenance for mutating commands (plan command-provenance). */
  remoteAddr?: { transport: string; hostname: string; port: number };
  body: {
    json(): Promise<unknown>;
  };
  /** pathfinder's managed WebSocket upgrade (0.2.4): the params bag declares
   * the RFC 6455 handshake fields — `protocol` is stamped as
   * Sec-WebSocket-Protocol on the 101. The handler owns the socket
   * lifecycle; it must return the placeholder `response`. */
  upgrade(params: { protocol?: string }): {
    response: Response;
    socket: Promise<WebSocket>;
  };
  _raw: Request;
}

export interface HatContext {
  app: {
    cfg: {
      version?: string;
      /** Seeded account — OwnTone playlists are global, Melofon's are
       * per-user; the hat reads this user's. Unset → empty list. */
      user?: string;
    };
    /** Boot time (ISO) — /api/library's started_at. */
    startedAt?: string;
    notify: {
      /** Listen for core change events (OwnTone names); returns unsubscribe. */
      subscribe(
        fn: (
          types: string[],
          keys: Record<string, string[]> | undefined,
          audience: 'all' | 'admins' | { userId: string },
        ) => void,
      ): () => void;
    };
    binds: {
      /** The actual bind of one of this hat's claimed ports (after env
       * remaps) — /api/config's websocket_port. */
      actual(layerName: string, claimed: number): number;
    };
    scan: {
      status(): Promise<ScanStatusRow>;
    };
    libraries: {
      /** The configured scan sources (files roots live here, not in the hat). */
      list(): Promise<{ id: string; name: string; path: string }[]>;
    };
    folders: {
      browse(options: {
        libraryId: string;
        path: string;
        folders: { offset: number; limit: number };
        songs: { offset: number; limit: number };
      }): Promise<{
        folders: { rows: { path: string }[]; total: number };
        songs: { rows: SongRow[]; total: number };
      }>;
    };
    playback: {
      /** THE playback core: every player/queue mutation and the engine
       * views. The hat parses into one command and encodes views back out —
       * it never merges stores, never emits. playerView is ENGINE ONLY
       * (stop ⇒ no current). Mutations take a provenance source. */
      playerView(): PlayerViewRow;
      queueView(): { version: number; items: QueueEntryRow[] };
      play(source?: CommandSourceRow): void | Promise<void>;
      pause(source?: CommandSourceRow): void;
      stop(source?: CommandSourceRow): void;
      toggle(source?: CommandSourceRow): void | Promise<void>;
      next(source?: CommandSourceRow): void | Promise<void>;
      previous(source?: CommandSourceRow): void | Promise<void>;
      setShuffle(on: boolean, source?: CommandSourceRow): void;
      setConsume(on: boolean, source?: CommandSourceRow): void;
      setRepeat(
        mode: 'off' | 'all' | 'single',
        source?: CommandSourceRow,
      ): void;
      setVolume(
        opts: { volume?: number; step?: number },
        source?: CommandSourceRow,
      ): void;
      seek(
        opts: { positionMs?: number; seekMs?: number },
        source?: CommandSourceRow,
      ): boolean | Promise<boolean>;
      /** OwnTone queue add: clear first, insert at position (omit = append),
       * shuffle when given, play (at playbackFromPosition) when asked. */
      queueAdd(
        songs: SongRow[],
        opts?: {
          position?: number;
          playbackFromPosition?: number;
          play?: boolean;
          clear?: boolean;
          shuffle?: boolean;
        },
        source?: CommandSourceRow,
      ): QueueEntryRow[] | Promise<QueueEntryRow[]>;
      queueClear(source?: CommandSourceRow): void;
      /** The last recorded engine mutation (provenance), null before any. */
      lastCommand(): LastCommandRow | null;
    };
    artwork: {
      /** Cover image for an album/song/artist id — always an image. */
      cover(id: string): Promise<Response>;
    };
    playlists: {
      list(username: string): Promise<PlaylistRow[]>;
      get(username: string, id: string): Promise<PlaylistWithTracks | null>;
    };
    speakers: {
      submitPin(id: string, input: unknown): Promise<unknown>;
    };
    outputs: {
      list(): OutputRow[];
      get(id: string): OutputRow | null;
      setEnabled(ids: string[], source?: CommandSourceRow): boolean;
      toggle(id: string, source?: CommandSourceRow): OutputRow | null;
      update(
        id: string,
        opts: { selected?: boolean; volume?: number; pin?: string },
        source?: CommandSourceRow,
      ): OutputRow | null;
    };
    library: {
      statistics(): Promise<{
        statistics: {
          songCount: number;
          durationMs: number;
          albumCount: number;
          browseArtistCount: number;
        };
      }>;
      listAlbums(opts: {
        sort: 'name' | 'genre';
        size: number;
        offset: number;
        genre?: string;
      }): Promise<AlbumRow[]>;
      getAlbum(
        id: string,
      ): Promise<{ album: AlbumRow; songs: SongRow[] } | null>;
      /** Stable-order catalog walk for deterministic wire-id resolution. */
      listSongs(opts: { offset: number; size: number }): Promise<SongRow[]>;
      /** Songs of one genre (genre URI expansion + genre search). */
      songsByGenre(
        genre: string,
        opts: { size: number; offset: number },
      ): Promise<SongRow[]>;
      listArtists(): Promise<ArtistRow[]>;
      getArtist(id: string): Promise<ArtistRow | null>;
      albumsByArtist(artistId: string): Promise<AlbumRow[]>;
      albumsWithoutArtist(kind: 'various' | 'unknown'): Promise<AlbumRow[]>;
      getSong(id: string): Promise<SongRow | null>;
      listGenres(): Promise<GenreRow[]>;
      search3(
        query: string,
        opts: {
          artistCount: number;
          artistOffset: number;
          albumCount: number;
          albumOffset: number;
          songCount: number;
          songOffset: number;
        },
      ): Promise<
        { artists: ArtistRow[]; albums: AlbumRow[]; songs: SongRow[] }
      >;
    };
  };
}

// Domain rows, declared structurally (the hat does not import src/).
export interface SongRow {
  pictureHash?: string | null;
  id: string;
  path: string;
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
  genre: string | null;
  year: number | null;
  isVideo: boolean;
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
}

export type QueueMediaRow =
  | {
    reference: { kind: 'song'; id: string };
    facts: { kind: 'song'; song: SongRow };
  }
  | {
    reference: { kind: 'station'; id: string } | { kind: 'url'; url: string };
    facts: {
      kind: 'web';
      url: string;
      title: string | null;
      artistName: string | null;
      durationMs: number | null;
      mode: 'live' | 'finite' | 'unknown';
      seekable: boolean;
      streamTitle: string | null;
      streamUrl: string | null;
    };
  };
export type QueueEntryRow = QueueMediaRow & { id: number };

export interface OutputRow {
  id: string;
  name: string;
  type: string;
  selected: boolean;
  volume: number;
  /** Set by a boot when the device wants a PIN/password (needs_auth_key). */
  needsAuthKey?: boolean;
  /** TXT `sf` bit 9 — OwnTone `requires_auth` on the wire. */
  requiresAuth?: boolean;
  hasPassword?: boolean;
}

export interface ArtistRow {
  id: string;
  name: string;
  albumCount: number;
}

export interface GenreRow {
  name: string;
  songCount: number;
  albumCount: number;
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

export interface ScanStatusRow {
  scanning: boolean;
  count: number;
  folderCount: number;
  lastScanMs: number | null;
}

export interface PlayerViewRow {
  state: 'play' | 'pause' | 'stop';
  repeat: 'off' | 'all' | 'single';
  consume: boolean;
  shuffle: boolean;
  volume: number;
  /** Engine entry, or a synthetic current (id −1) for a mirrored client
   * report; null when neither plane has anything. */
  current: QueueEntryRow | null;
  itemLengthMs: number;
  itemProgressMs: number;
}
