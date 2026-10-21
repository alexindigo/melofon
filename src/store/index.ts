import { openEngine, registerStore } from './engine.ts';
import type { Log } from '../logging.ts';
import { createUsersStore } from './users.ts';
import { createStateStore } from './state.ts';
import { createBookmarksStore } from './bookmarks.ts';
import { createClientQueueStore } from './clientqueue.ts';
import { createNowPlayingStore } from './nowplaying.ts';
import { createListensStore } from './listens.ts';
import { createAnnotationsStore } from './annotations.ts';
import { createPlaylistsStore } from './playlists.ts';
import { createRadioStore } from './radio.ts';
import { createPlaybackStore } from './playback.ts';
import { createCatalogStore } from './catalog.ts';
import { createCandidatesStore } from './candidates.ts';
import { createLookupsStore } from './lookups.ts';
import { createReferenceStore } from './reference.ts';
import { createReferenceMatcherStore } from './reference-matcher.ts';

export interface Store {
  users: ReturnType<typeof createUsersStore>;
  state: ReturnType<typeof createStateStore>;
  bookmarks: ReturnType<typeof createBookmarksStore>;
  clientQueue: ReturnType<typeof createClientQueueStore>;
  nowPlaying: ReturnType<typeof createNowPlayingStore>;
  listens: ReturnType<typeof createListensStore>;
  annotations: ReturnType<typeof createAnnotationsStore>;
  playlists: ReturnType<typeof createPlaylistsStore>;
  radio: ReturnType<typeof createRadioStore>;
  playback: ReturnType<typeof createPlaybackStore>;
  catalog: ReturnType<typeof createCatalogStore>;
  candidates: ReturnType<typeof createCandidatesStore>;
  lookups: ReturnType<typeof createLookupsStore>;
  reference: ReturnType<typeof createReferenceStore>;
  referenceMatcher: ReturnType<typeof createReferenceMatcherStore>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export async function openStore(
  dataDir: string,
  opts: { debugLogQueries?: boolean; log?: Log } = {},
): Promise<Store> {
  const engine = await openEngine(dataDir, opts);
  const store: Store = {
    users: createUsersStore(engine),
    state: createStateStore(engine),
    bookmarks: createBookmarksStore(engine),
    clientQueue: createClientQueueStore(engine),
    nowPlaying: createNowPlayingStore(engine),
    listens: createListensStore(engine),
    annotations: createAnnotationsStore(engine),
    playlists: createPlaylistsStore(engine),
    radio: createRadioStore(engine),
    playback: createPlaybackStore(engine),
    catalog: createCatalogStore(engine),
    candidates: createCandidatesStore(engine),
    lookups: createLookupsStore(engine),
    reference: createReferenceStore(engine),
    referenceMatcher: createReferenceMatcherStore(engine),
    ping: engine.ping,
    close: engine.close,
  };
  registerStore(store, engine);
  try {
    await store.lookups.resetActive();
  } catch (error) {
    await engine.close();
    throw error;
  }
  return store;
}
