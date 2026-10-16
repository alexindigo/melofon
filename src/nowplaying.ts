// app.nowPlaying: client sessions (plane B), written via playback commands.
import type { Store } from './store/index.ts';
import type { NowPlayingRow } from './store/nowplaying.ts';
export type { NowPlayingRow } from './store/nowplaying.ts';

export interface NowPlaying {
  /** Replace the (user, client) row — a new play supersedes the old one. */
  set(
    username: string,
    client: string,
    trackId: string,
    streamId: string,
    positionMs?: number,
  ): Promise<void>;
  /** Clear only the row whose streamId is still current. */
  clearByStreamId(streamId: string): Promise<boolean>;
  list(): Promise<NowPlayingRow[]>;
}

export function createNowPlaying(store: Store): NowPlaying {
  return store.nowPlaying;
}
