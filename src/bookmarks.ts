// app.bookmarks: per-user playback-position bookmarks, kept across scans.
import type { Store } from './store/index.ts';
export type { BookmarkRow } from './store/bookmarks.ts';

export interface Bookmarks {
  /** Newest-changed first. */
  list(username: string): Promise<import('./store/bookmarks.ts').BookmarkRow[]>;
  /** Upsert: created_at survives updates, changed_at moves. */
  set(
    username: string,
    trackId: string,
    positionMs: number,
    comment?: string,
  ): Promise<void>;
  remove(username: string, trackId: string): Promise<void>;
}

export function createBookmarks(store: Store): Bookmarks {
  return store.bookmarks;
}
