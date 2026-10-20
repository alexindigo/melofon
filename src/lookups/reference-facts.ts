import type { Store } from '../store/index.ts';
import type { ReferenceType } from '../reference-types.ts';

export interface ArtistFacts {
  contract: 1;
  type: 'artist';
  id: string;
  name: string;
  ids: Record<string, string>;
  albums: string[];
}
export interface TrackFacts {
  contract: 1;
  type: 'track';
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  ids: Record<string, string>;
  artistIds: Record<string, string>;
}
export async function referenceFacts(
  store: Store,
  type: ReferenceType,
  id: string,
): Promise<ArtistFacts | TrackFacts | null> {
  if (type === 'artist') {
    const artist = await store.catalog.artistById(id);
    // Synthetic various/unknown kinds have no artists row. Never look them up
    // by a protocol-built display label, even if supplied as an id.
    if (!artist?.name.trim()) return null;
    return {
      contract: 1,
      type,
      id,
      name: artist.name,
      ids: artist.musicBrainzId ? { mbid: artist.musicBrainzId } : {},
      albums: (await store.catalog.albumsByArtist(id)).flatMap((a) =>
        a.name === null ? [] : [a.name]
      ),
    };
  }
  const song = await store.catalog.getSong(id);
  if (!song) return null;
  const artist = song.artistId
    ? await store.catalog.artistById(song.artistId)
    : null;
  return {
    contract: 1,
    type,
    id,
    title: song.title,
    artist: song.artistName,
    album: song.albumName,
    durationMs: song.durationMs,
    ids: {
      ...(song.metadata?.recordingMbid
        ? { mbid: song.metadata.recordingMbid }
        : {}),
      ...(song.metadata?.isrc?.[0] ? { isrc: song.metadata.isrc[0] } : {}),
    },
    artistIds: artist?.musicBrainzId ? { mbid: artist.musicBrainzId } : {},
  };
}
