// src/playlists.ts — app.playlists: per-user ordered track lists. The store
// resolves ownership and atomically rewrites positions on each mutation.
import type { Store } from './store/index.ts';
import type {
  PlaylistRow,
  PlaylistUpdate,
  PlaylistWithTracks,
} from './store/playlists.ts';
export type { PlaylistRow, PlaylistWithTracks } from './store/playlists.ts';

export interface Playlists {
  /** The caller's own playlists, by name. */
  list(username: string): Promise<PlaylistRow[]>;
  get(username: string, id: string): Promise<PlaylistWithTracks | null>;
  create(
    username: string,
    name: string,
    trackIds: string[],
  ): Promise<PlaylistWithTracks>;
  /** Replace the whole track list (Subsonic createPlaylist-by-playlistId). */
  setTracks(
    username: string,
    id: string,
    trackIds: string[],
  ): Promise<PlaylistWithTracks | null>;
  /** Metadata edits + incremental adds/removes (Subsonic updatePlaylist). */
  update(
    username: string,
    id: string,
    opts: PlaylistUpdate,
  ): Promise<PlaylistWithTracks | null>;
  delete(username: string, id: string): Promise<boolean>;
}

export function createPlaylists(store: Store): Playlists {
  return {
    list: (username) => store.playlists.list(username),
    get: (username, id) => store.playlists.get(username, id),
    create: (username, name, trackIds) =>
      store.playlists.create(username, name, trackIds),
    setTracks: (username, id, trackIds) =>
      store.playlists.setTracks(username, id, trackIds),
    update: (username, id, opts) => store.playlists.update(username, id, opts),
    delete: (username, id) => store.playlists.delete(username, id),
  };
}
