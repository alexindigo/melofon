// Sharing enablement and ownership are core policy, independent of any hat.
import type { Store } from './store/index.ts';
import type { State } from './state.ts';
import type { AlbumRow, Library, SongRow } from './library.ts';
import type { Playlists } from './playlists.ts';
import type { ShareKind, ShareRow } from './store/shares.ts';
export type { ShareRow } from './store/shares.ts';

export interface ShareOptions {
  description?: string;
  expires?: number;
}
const validExpiry = (n: number) =>
  Number.isSafeInteger(n) && Number.isFinite(new Date(n).getTime());

export function createShares(
  store: Store,
  state: State,
  library: Library,
  playlists: Playlists,
) {
  state.declare('sharing.enabled', { type: 'boolean', default: false });
  state.declare('sharing.defaultExpirationDays', {
    type: 'number',
    minimum: 0,
    default: 365,
  });
  state.declare('sharing.downloadableByDefault', {
    type: 'boolean',
    default: false,
  });
  state.declare('sharing.maxConcurrentStreams', {
    type: 'integer',
    minimum: 1,
    default: 4,
  });
  // Live admission belongs to this service instance, never hat module state.
  const streams = new Map<string, number>();
  state.declare('server.publicUrl', {
    type: 'string',
    default: '',
    pattern: '^(?:|https?://[^\\s/?#]+(?:[/?#][^\\s]*)?)$',
    description:
      'Absolute http/https public URL; its path prefixes public links. Empty uses the request origin.',
  });
  const enabled = async () => await state.getTyped('sharing.enabled') === true;
  async function writable(caller: string, id: string) {
    const user = await store.users.profile(caller);
    if (!user) return 'forbidden' as const;
    const row = await store.shares.get(id);
    return !row
      ? null
      : row.owner === caller || user.role === 'admin'
      ? row
      : 'forbidden' as const;
  }
  async function kind(owner: string, id: string): Promise<ShareKind | null> {
    if (await library.getSong(id)) return 'song';
    if (await library.getAlbum(id)) return 'album';
    if (await library.artistById(id)) return 'artist';
    if (await playlists.get(owner, id)) return 'playlist';
    return null;
  }
  async function contents(
    share: ShareRow,
  ): Promise<{ albums: AlbumRow[]; tracks: SongRow[] }> {
    const albums: AlbumRow[] = [], tracks: SongRow[] = [];
    // Re-read authoritative ownership/resources; a stale snapshot grants nothing.
    const row = await store.shares.get(share.id);
    if (
      !row || !await enabled() ||
      row.expiresAtMs !== null && row.expiresAtMs <= Date.now() ||
      !await store.users.profile(row.owner)
    ) {
      return { albums, tracks };
    }
    for (const id of row.resourceIds) {
      if (row.resourceType === 'song') {
        const song = await library.getSong(id);
        if (song) tracks.push(song);
      } else if (row.resourceType === 'playlist') {
        const playlist = await playlists.get(row.owner, id);
        for (const trackId of playlist?.trackIds ?? []) {
          const song = await library.getSong(trackId);
          if (song) tracks.push(song);
        }
      } else {
        const selected = row.resourceType === 'artist'
          ? await library.albumsByArtist(id)
          : (await library.getAlbum(id))?.album;
        for (
          const album of Array.isArray(selected)
            ? selected
            : selected
            ? [selected]
            : []
        ) {
          const current = await library.getAlbum(album.id);
          if (current) {
            albums.push(current.album);
            tracks.push(...current.songs);
          }
        }
      }
    }
    return { albums, tracks };
  }
  return {
    enabled,
    async admitStream(id: string): Promise<(() => void) | null> {
      const limit = Number(
        await state.getTyped('sharing.maxConcurrentStreams'),
      );
      const count = streams.get(id) ?? 0;
      if (count >= limit) return null;
      streams.set(id, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (streams.get(id) ?? 1) - 1;
        if (remaining) streams.set(id, remaining);
        else streams.delete(id);
      };
    },
    async publicUrl(): Promise<string> {
      const value = await state.getTyped('server.publicUrl') as string;
      if (!value) return '';
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
        throw new Error('Invalid server.publicUrl');
      }
      return url.origin + url.pathname.replace(/\/+$/, '');
    },
    async create(
      owner: string,
      ids: string[],
      options: ShareOptions = {},
    ): Promise<ShareRow | 'disabled' | null | { invalid: string }> {
      if (!await enabled()) return 'disabled';
      if (!ids.length || !await store.users.profile(owner)) return null;
      let resourceType: ShareKind | null = null;
      for (const id of ids) {
        const found = await kind(owner, id);
        if (!found || (resourceType !== null && resourceType !== found)) {
          return null;
        }
        resourceType = found;
      }
      const expires = options.expires ??
        Date.now() +
          (await state.getTyped('sharing.defaultExpirationDays') as number) *
            86400000;
      if (!validExpiry(expires)) return { invalid: 'Invalid share expiration' };
      return store.shares.create({
        owner,
        resourceIds: [...ids],
        resourceType: resourceType!,
        description: options.description ?? '',
        expiresAtMs: expires,
        downloadable:
          await state.getTyped('sharing.downloadableByDefault') === true,
      });
    },
    async list(caller: string) {
      const user = await store.users.profile(caller);
      return user
        ? store.shares.list(user.role === 'admin' ? undefined : caller)
        : [];
    },
    async update(
      caller: string,
      id: string,
      options: ShareOptions,
    ): Promise<ShareRow | 'forbidden' | null | { invalid: string }> {
      const row = await writable(caller, id);
      if (row === null || row === 'forbidden') return row;
      if (options.expires !== undefined && !validExpiry(options.expires)) {
        return { invalid: 'Invalid share expiration' };
      }
      return store.shares.update(id, {
        description: options.description,
        expiresAtMs: options.expires === undefined
          ? undefined
          : options.expires === 0
          ? null
          : options.expires,
      });
    },
    async delete(caller: string, id: string): Promise<boolean | 'forbidden'> {
      const row = await writable(caller, id);
      return row === 'forbidden'
        ? row
        : row === null
        ? false
        : store.shares.delete(id);
    },
    async open(id: string): Promise<ShareRow | 'expired' | null> {
      return await enabled() ? store.shares.open(id, Date.now()) : null;
    },
    /** Validate public access without recording a page/playlist/download visit. */
    async resolve(id: string): Promise<ShareRow | 'expired' | null> {
      if (!await enabled()) return null;
      const row = await store.shares.get(id);
      return row && row.expiresAtMs !== null && row.expiresAtMs <= Date.now()
        ? 'expired'
        : row;
    },
    contents,
    tracks: async (share: ShareRow) => (await contents(share)).tracks,
  };
}
