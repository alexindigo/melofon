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
  _raw: Request;
}

export interface HatContext {
  app: {
    cfg: {
      version?: string;
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
