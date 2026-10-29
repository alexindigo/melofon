// src/playlists.ts — app.playlists owns visibility and edit/delete policy.
// The store keeps occurrences and resolves visible indices atomically.
import type { Store } from './store/index.ts';
import type {
  PlaylistPage,
  PlaylistPageOptions,
  PlaylistRow,
  PlaylistUpdate,
  PlaylistWithTracks,
} from './store/playlists.ts';
export type { PlaylistRow, PlaylistWithTracks } from './store/playlists.ts';

export interface Playlists {
  /** Current own/public visibility (admins see all), paged before returning. */
  containingSong(
    username: string,
    songId: string,
    opts: PlaylistPageOptions,
  ): Promise<PlaylistPage | null>;
  /** Own-only view used by OwnTone, even when the seeded user is admin. */
  list(username: string): Promise<PlaylistRow[]>;
  visible(
    username: string,
    forUsername?: string,
  ): Promise<PlaylistRow[] | null | 'forbidden'>;
  get(username: string, id: string): Promise<PlaylistWithTracks | null>;
  create(
    username: string,
    name: string,
    trackIds: string[],
    public_?: boolean,
  ): Promise<PlaylistWithTracks>;
  /** Replace the whole track list (Subsonic createPlaylist-by-playlistId). */
  setTracks(
    username: string,
    id: string,
    trackIds: string[],
    public_?: boolean,
  ): Promise<PlaylistWithTracks | null | 'forbidden'>;
  /** Metadata edits + incremental adds/removes (Subsonic updatePlaylist). */
  update(
    username: string,
    id: string,
    opts: PlaylistUpdate,
  ): Promise<PlaylistWithTracks | null | 'forbidden'>;
  delete(username: string, id: string): Promise<boolean | 'forbidden'>;
}

export function createPlaylists(store: Store): Playlists {
  async function get(username: string, id: string) {
    const user = await store.users.profile(username);
    if (user === null) return null;
    const row = await store.playlists.find(id);
    return row &&
        (row.owner === username || row.public || user.role === 'admin')
      ? row
      : null;
  }
  async function writable(username: string, id: string) {
    const row = await get(username, id);
    return row === null
      ? null
      : row.owner === username
      ? row
      : 'forbidden' as const;
  }
  return {
    async containingSong(username, songId, opts) {
      const user = await store.users.profile(username);
      if (user === null) return null;
      return await store.playlists.containingSong(
        songId,
        opts,
        user.role === 'admin' ? undefined : username,
        true,
      );
    },
    list: (username) => store.playlists.list(username),
    async visible(username, forUsername) {
      const user = await store.users.profile(username);
      if (user === null) return null;
      if (forUsername !== undefined) {
        if (user.role !== 'admin') return 'forbidden';
        if (await store.users.profile(forUsername) === null) return null;
        return await store.playlists.list(forUsername, true);
      }
      return await store.playlists.list(
        user.role === 'admin' ? undefined : username,
        true,
      );
    },
    get,
    create: (username, name, trackIds, public_) =>
      store.playlists.create(username, name, trackIds, public_),
    async setTracks(username, id, trackIds, public_) {
      const row = await writable(username, id);
      if (row === null || row === 'forbidden') return row;
      return await store.playlists.setTracks(username, id, trackIds, public_);
    },
    async update(username, id, opts) {
      const row = await writable(username, id);
      if (row === null || row === 'forbidden') return row;
      return await store.playlists.update(username, id, opts);
    },
    async delete(username, id) {
      const row = await get(username, id);
      if (row === null) return false;
      if (
        row.owner !== username &&
        (await store.users.profile(username))?.role !== 'admin'
      ) return 'forbidden';
      return await store.playlists.delete(row.owner, id);
    },
  };
}
