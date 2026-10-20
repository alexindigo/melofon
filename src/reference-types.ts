// Plain reference vocabulary shared by the service, store and lookup boundary.
export const artistReferenceNames = [
  'artist.biography',
  'artist.url',
  'artist.id.mbid',
  'artist.similar',
  'artist.topTracks',
] as const;
export const trackReferenceNames = ['track.similar'] as const;
export type ReferenceType = 'artist' | 'track';
export type ReferenceName =
  | typeof artistReferenceNames[number]
  | typeof trackReferenceNames[number];
export interface ExternalArtist {
  name: string;
  mbid?: string;
}
export interface ExternalTrack {
  title: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  mbid?: string;
  isrc?: string;
}
export interface ReferenceValues {
  'artist.biography'?: { text: string; language?: string };
  'artist.url'?: { url: string };
  'artist.id.mbid'?: string;
  'artist.similar'?: ExternalArtist[];
  'artist.topTracks'?: ExternalTrack[];
  'track.similar'?: ExternalTrack[];
}
export function referenceNames(type: ReferenceType): readonly ReferenceName[] {
  return type === 'artist' ? artistReferenceNames : trackReferenceNames;
}
