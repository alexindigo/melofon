// app.listens: append-only scrobbles and per-user play facts.
import type { Store } from './store/index.ts';
import type { Play } from './store/listens.ts';
export type { Play } from './store/listens.ts';

export interface Listens {
  /** false when the track is not a catalog file. */
  record(
    username: string,
    trackId: string,
    opts: { source: string; playedAtMs?: number; durationMs?: number },
  ): Promise<boolean>;
  facts(
    username: string,
    ids: { songs?: string[]; albums?: string[]; artists?: string[] },
  ): Promise<{
    songs: Record<string, Play>;
    albums: Record<string, Play>;
    artists: Record<string, Play>;
  }>;
}

export function createListens(store: Store): Listens {
  return store.listens;
}
