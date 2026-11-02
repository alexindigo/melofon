import type { Store } from './store/index.ts';
import type { State } from './state.ts';
import {
  type ReferenceName,
  referenceNames,
  type ReferenceType,
  type ReferenceValues,
} from './reference-types.ts';
import type { ReferenceCapability } from './lookups/manifest.ts';
import { createReferenceMatcher } from './reference-matcher.ts';

export interface ReferenceProvider {
  plugin: string;
  capability: ReferenceCapability;
}
export interface RadioOptions {
  /** Omit only for legacy callers that resolve song, then album, then artist. */
  type?: 'song' | 'album' | 'artist';
  folderId?: string;
}
/** Reference policy owns settings and selection; the lookup runner alone owns
 * Workers and persistent job intake. Neither reads nor refreshes await a Worker. */
export function createReference(options: {
  store: Store;
  state: State;
  providers: (type: ReferenceType) => Promise<ReferenceProvider[]>;
  enqueue: (
    type: ReferenceType,
    id: string,
    providers: ReferenceProvider[],
  ) => Promise<void>;
  now?: () => number;
  random?: () => number;
}) {
  const { store, state } = options;
  const matcher = createReferenceMatcher(store, state);
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  state.declare('reference.order', {
    type: 'array',
    items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    default: [],
  });
  state.declare('reference.refreshHours', {
    type: 'number',
    minimum: 0.001,
    maximum: 87600,
    default: 24,
  });
  state.declare('reference.maxListItems', {
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    default: 100,
  });
  for (
    const [name, value] of Object.entries({
      radioAlbumSeeds: 5,
      radioSimilarArtists: 15,
      radioMinTopTracks: 20,
    })
  ) {
    state.declare(`reference.${name}`, {
      type: 'integer',
      minimum: 1,
      maximum: 10000,
      default: value,
    });
  }
  state.declare('reference.radioArtistWeight', {
    type: 'number',
    minimum: 1,
    maximum: 100,
    default: 3.5,
  });
  const setting = async (name: string) =>
    await state.getTyped(`reference.${name}`) as number;
  const validCount = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('Invalid reference count');
    }
  };
  const shuffle = (ids: string[]) => {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids;
  };
  const artistMix = async (
    artistId: string,
    count: number,
    user: string,
    exclude?: string,
    folderId?: string,
  ) => {
    const similar = await service.similarArtists(
      artistId,
      await setting('radioSimilarArtists'),
      true,
      folderId,
    );
    const artists = [
      artistId,
      ...similar.flatMap((a) => a.present ? [a.id] : []),
    ];
    const topCount = Math.max(count, await setting('radioMinTopTracks'));
    const seedWeight = await setting('radioArtistWeight');
    const weights = new Map<string, number>();
    for (const id of new Set(artists)) {
      const tracks = await service.topTracks(
        id,
        topCount,
        user,
        folderId,
        exclude,
      );
      tracks.forEach((track, index) => {
        if (track === exclude) return;
        const weight = id === artistId
          ? topCount * seedWeight - index
          : topCount - index;
        weights.set(track, (weights.get(track) ?? 0) + weight);
      });
    }
    const result: string[] = [];
    while (weights.size && result.length < count) {
      let pick = random() * [...weights.values()].reduce((a, b) => a + b, 0);
      for (const [id, weight] of weights) {
        pick -= weight;
        if (pick < 0) {
          result.push(id);
          weights.delete(id);
          break;
        }
      }
    }
    return result;
  };
  const capLists = async (
    values: ReferenceValues,
  ): Promise<ReferenceValues> => {
    const max = await state.getTyped('reference.maxListItems') as number;
    return Object.fromEntries(
      Object.entries(values).map((
        [name, value],
      ) => [name, Array.isArray(value) ? value.slice(0, max) : value]),
    );
  };
  const providers = async (type: ReferenceType) => {
    const available = await options.providers(type);
    const order = await state.getTyped('reference.order') as string[];
    const rank = (plugin: string) => {
      const index = order.indexOf(plugin);
      return index < 0 ? order.length : index;
    };
    return available.sort((a, b) => rank(a.plugin) - rank(b.plugin));
  };
  const service = {
    async get(
      type: ReferenceType,
      id: string,
      names: readonly ReferenceName[],
    ): Promise<ReferenceValues> {
      if (!names.every((name) => referenceNames(type).includes(name))) {
        throw new Error('Reference name does not match entity type');
      }
      const available = await providers(type);
      const facts = await store.reference.get(type, id);
      const cutoff = now() -
        (await state.getTyped('reference.refreshHours') as number) * 3600000;
      const pending: ReferenceProvider[] = [];
      const selected: Record<string, unknown> = {};
      const stale: Record<string, unknown> = {};
      for (const provider of available) {
        let needsFetch = false;
        for (const name of names) {
          if (!provider.capability.provides.includes(name)) continue;
          const fact = facts.find((f) =>
            f.name === name && f.plugin === provider.plugin
          );
          if (!fact || fact.fetchedAtMs < cutoff) needsFetch = true;
          if (fact?.value == null) continue;
          const destination = fact.fetchedAtMs < cutoff ? stale : selected;
          if (!(name in destination)) destination[name] = fact.value;
        }
        if (needsFetch) pending.push(provider);
      }
      // Only local store intake is awaited, never plugin readiness/network/results.
      if (pending.length) await options.enqueue(type, id, pending);
      return capLists({ ...stale, ...selected } as ReferenceValues);
    },
    async refresh(type: ReferenceType, id: string): Promise<void> {
      await options.enqueue(type, id, await providers(type));
    },
    async similarTracks(
      trackId: string,
      count: number,
      user: string,
      folderId?: string,
    ): Promise<string[]> {
      validCount(count);
      const values = await service.get('track', trackId, ['track.similar']);
      return values['track.similar']?.length
        ? matcher.tracks(
          values['track.similar'],
          count,
          user,
          trackId,
          folderId,
        )
        : store.referenceMatcher.genreTracks(trackId, count, folderId);
    },
    async topTracks(
      artistId: string,
      count: number,
      user: string,
      folderId?: string,
      exclude?: string,
    ): Promise<string[]> {
      validCount(count);
      const values = await service.get('artist', artistId, [
        'artist.topTracks',
      ]);
      return values['artist.topTracks']?.length
        ? matcher.tracks(
          values['artist.topTracks'],
          count,
          user,
          exclude,
          folderId,
        )
        : store.referenceMatcher.localTopTracks(
          artistId,
          count,
          user,
          folderId,
          exclude,
        );
    },
    artistByName: store.referenceMatcher.artistByName,
    /** Unknown seed is distinct from a known seed with an empty local mix. */
    async radio(
      seedId: string,
      count: number,
      user: string,
      options: RadioOptions = {},
    ): Promise<string[] | null> {
      validCount(count);
      const { type, folderId } = options;
      const song = type === undefined || type === 'song'
        ? await store.catalog.getSong(seedId)
        : null;
      if (song) {
        if (
          !(await store.referenceMatcher.eligibleTracks([seedId], folderId))
            .length
        ) return null;
        if (!count) return [];
        const tracks = await service.similarTracks(
          seedId,
          count,
          user,
          folderId,
        );
        if (tracks.length < count && song.artistId) {
          tracks.push(
            ...await artistMix(song.artistId, count, user, seedId, folderId),
          );
        }
        return [...new Set(tracks)].filter((id) => id !== seedId).slice(
          0,
          count,
        );
      }
      const album = type === undefined || type === 'album'
        ? await store.catalog.getAlbum(seedId)
        : null;
      if (album) {
        const eligible = await store.referenceMatcher.eligibleTracks(
          album.songs.map((s) => s.id),
          folderId,
        );
        if (!eligible.length) return null;
        if (!count) return [];
        const present = new Set(eligible);
        const seeds = shuffle(
          album.songs.filter((s) => present.has(s.id)).map((s) => s.id),
        )
          .slice(0, await setting('radioAlbumSeeds'));
        const tracks: string[] = [];
        for (const id of seeds) {
          tracks.push(
            ...await service.similarTracks(id, count, user, folderId),
          );
        }
        return shuffle([...new Set(tracks)]).slice(0, count);
      }
      const artist = (type === undefined || type === 'artist') &&
        (await store.referenceMatcher.artists(folderId)).some((a) =>
          a.id === seedId
        );
      return artist
        ? count ? artistMix(seedId, count, user, undefined, folderId) : []
        : null;
    },
    async similarArtists(
      artistId: string,
      count: number,
      presentOnly = false,
      folderId?: string,
    ) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError('Invalid reference count');
      }
      const values = await service.get('artist', artistId, ['artist.similar']);
      const artists = await matcher.artists(
        values['artist.similar'] ?? [],
        folderId,
      );
      return (presentOnly ? artists.filter((a) => a.present) : artists).slice(
        0,
        count,
      );
    },
    async record(
      type: ReferenceType,
      id: string,
      plugin: string,
      names: readonly ReferenceName[],
      values: ReferenceValues,
    ): Promise<void> {
      await store.reference.put(
        type,
        id,
        plugin,
        names,
        await capLists(values),
        now(),
      );
    },
  };
  return service;
}
export type Reference = Pick<
  ReturnType<typeof createReference>,
  | 'get'
  | 'refresh'
  | 'similarTracks'
  | 'topTracks'
  | 'similarArtists'
  | 'artistByName'
  | 'radio'
>;
