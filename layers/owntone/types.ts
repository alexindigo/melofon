// layers/owntone/types.ts — the owntone hat's structural types. This module
// lives at the layer root, outside the walked mount tree
// (layers/owntone/api/): shared code, not routes. The hat is self-sufficient:
// no src/ imports, no other hat's modules — core injects the service bag
// declared here on context.app.

export interface HatRequest {
  params: Record<string, string>;
  query: URLSearchParams;
  method: string;
  headers: Headers;
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
      subscribe(fn: (types: string[]) => void): () => void;
    };
    binds: {
      /** The actual bind of one of this hat's claimed ports (after env
       * remaps) — /api/config's websocket_port. */
      actual(layerName: string, claimed: number): number;
    };
    scan: {
      status(): Promise<ScanStatusRow>;
    };
    playback: {
      /** THE shared player read (engine wins, else mirrored client report).
       * The hat encodes; it never merges stores itself. */
      playerView(): Promise<PlayerViewRow>;
    };
    artwork: {
      /** Cover image for an album/song/artist id — always an image. */
      cover(id: string): Promise<Response>;
    };
    playlists: {
      list(username: string): Promise<PlaylistRow[]>;
      get(username: string, id: string): Promise<PlaylistWithTracks | null>;
    };
    player: {
      status(): PlayerStatusRow;
      play(): void;
      pause(): void;
      stop(): void;
      toggle(): void;
      next(): void;
      previous(): void;
      setShuffle(on: boolean): void;
      setConsume(on: boolean): void;
      setRepeat(mode: 'off' | 'all' | 'single'): void;
      setVolume(opts: { volume?: number; step?: number }): void;
      seek(opts: { positionMs?: number; seekMs?: number }): boolean;
      queue(): { version: number; items: QueueEntryRow[] };
      queueAdd(songs: SongRow[]): QueueEntryRow[];
      queueClear(): void;
    };
    outputs: {
      list(): OutputRow[];
      get(id: string): OutputRow | null;
      setEnabled(ids: string[]): boolean;
      toggle(id: string): OutputRow | null;
      update(
        id: string,
        opts: { selected?: boolean; volume?: number },
      ): OutputRow | null;
    };
    library: {
      listAlbums(opts: {
        sort: 'name';
        size: number;
        offset: number;
      }): Promise<AlbumRow[]>;
      getAlbum(
        id: string,
      ): Promise<{ album: AlbumRow; songs: SongRow[] } | null>;
      /** Borrowed as the all-songs scan for wire-id resolution (app.library
       * has no list-all; a ceiling size returns the whole catalog). */
      randomSongs(size: number): Promise<SongRow[]>;
      listArtists(): Promise<ArtistRow[]>;
      getArtist(id: string): Promise<ArtistRow | null>;
      albumsByArtist(artistId: string): Promise<AlbumRow[]>;
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
  id: string;
  path: string;
  title: string;
  albumId: string | null;
  albumName: string | null;
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
  name: string;
  artistId: string;
  artistName: string;
  songCount: number;
  durationMs: number;
}

export interface QueueEntryRow {
  id: number;
  song: SongRow;
}

export interface PlayerStatusRow {
  state: 'play' | 'pause' | 'stop';
  repeat: 'off' | 'all' | 'single';
  consume: boolean;
  shuffle: boolean;
  volume: number;
  current: QueueEntryRow | null;
  itemLengthMs: number;
  itemProgressMs: number;
}

export interface OutputRow {
  id: string;
  name: string;
  type: string;
  selected: boolean;
  volume: number;
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
  current: { id: number; song: SongRow } | null;
  itemLengthMs: number;
  itemProgressMs: number;
}
