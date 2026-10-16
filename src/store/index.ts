import { type Engine, openEngine } from './engine.ts';
import type { Log } from '../logging.ts';
import { createUsersStore } from './users.ts';
import { createStateStore } from './state.ts';
import { createBookmarksStore } from './bookmarks.ts';
import { createClientQueueStore } from './clientqueue.ts';
import { createNowPlayingStore } from './nowplaying.ts';
import { createListensStore } from './listens.ts';

export interface Store {
  users: ReturnType<typeof createUsersStore>;
  state: ReturnType<typeof createStateStore>;
  bookmarks: ReturnType<typeof createBookmarksStore>;
  clientQueue: ReturnType<typeof createClientQueueStore>;
  nowPlaying: ReturnType<typeof createNowPlayingStore>;
  listens: ReturnType<typeof createListensStore>;
  ping(): Promise<void>;
  close(): Promise<void>;
  /** Transitional raw access for domains not yet moved (removed in S5). */
  legacy: Engine['legacy'];
}

export async function openStore(
  dataDir: string,
  opts: { debugLogQueries?: boolean; log?: Log } = {},
): Promise<Store> {
  const engine = await openEngine(dataDir, opts);
  return {
    users: createUsersStore(engine),
    state: createStateStore(engine),
    bookmarks: createBookmarksStore(engine),
    clientQueue: createClientQueueStore(engine),
    nowPlaying: createNowPlayingStore(engine),
    listens: createListensStore(engine),
    ping: engine.ping,
    close: engine.close,
    legacy: engine.legacy,
  };
}
