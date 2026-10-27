// SQL representation of catalog metadata. The scanner supplies facts; only the
// store knows columns, literals and read projections.
import { esc, type Queries } from './engine.ts';
import type { AlbumMetadata, SongMetadata } from '../metadata.ts';

export const songMetadataColumns: Record<keyof SongMetadata, string> = {
  bitRate: 'bit_rate',
  bitDepth: 'bit_depth',
  sampleRate: 'sample_rate',
  channels: 'channels',
  trackGain: 'track_gain',
  trackPeak: 'track_peak',
  albumGain: 'album_gain',
  albumPeak: 'album_peak',
  baseGain: 'base_gain',
  recordingMbid: 'recording_mbid',
  artistMbid: 'artist_mbid',
  albumArtistMbid: 'album_artist_mbid',
  isrc: 'isrc',
  genres: 'genres',
  moods: 'moods',
  comment: 'comment',
  sortTitle: 'sort_title',
  artistSortName: 'artist_sort_name',
  albumArtistSortName: 'album_artist_sort_name',
  bpm: 'bpm',
  explicit: 'explicit',
  discSubtitle: 'disc_subtitle',
  albumMbid: 'album_mbid',
  recordLabels: 'record_labels',
  releaseTypes: 'release_types',
  releaseDate: 'release_date',
  originalReleaseDate: 'original_release_date',
  compilation: 'compilation',
  version: 'version',
  albumSortName: 'album_sort_name',
};
export const albumMetadataColumns: Record<keyof AlbumMetadata, string> = {
  musicBrainzId: 'musicbrainz_id',
  recordLabels: 'record_labels',
  releaseTypes: 'release_types',
  genres: 'genres',
  moods: 'moods',
  releaseDate: 'release_date',
  originalReleaseDate: 'original_release_date',
  compilation: 'compilation',
  version: 'version',
  sortName: 'sort_name',
  explicit: 'explicit',
  discTitles: 'disc_titles',
};

export function metadataSelect(
  columns: Record<string, string>,
  alias: string,
  aggregate = false,
): string {
  const entries = Object.entries(columns).flatMap(([key, column]) => {
    const raw = `${alias}.${column}`;
    const value =
      ['isrc', 'genres', 'moods', 'recordLabels', 'releaseTypes'].includes(key)
        ? `COALESCE(${raw}, []::VARCHAR[])`
        : key === 'discTitles'
        ? `COALESCE(${raw}, '[]'::JSON)`
        : key === 'compilation'
        ? `COALESCE(${raw}, false)`
        : raw;
    return [esc(key), aggregate ? `first(${value})` : value];
  });
  // An unscanned row has no metadata facts at all. Keep that distinct from a
  // scanned row with known-empty tags; wire defaults belong to each hat.
  const present = Object.values(columns).map((column) => {
    const raw = `${alias}.${column}`;
    return `${aggregate ? `first(${raw})` : raw} IS NOT NULL`;
  }).join(' OR ');
  return `CASE WHEN ${present} THEN json_object(${
    entries.join(', ')
  })::VARCHAR ELSE NULL END AS metadata_json`;
}

export async function writeMetadata(
  q: Queries,
  table: 'files' | 'albums',
  id: string,
  metadata: SongMetadata | AlbumMetadata | undefined,
): Promise<void> {
  if (!metadata) return;
  const columns = table === 'files'
    ? songMetadataColumns
    : albumMetadataColumns;
  const assignments = Object.entries(columns).map(([key, column]) => {
    const value = (metadata as unknown as Record<string, unknown>)[key];
    const literal = value == null
      ? 'NULL'
      : typeof value === 'string'
      ? esc(value)
      : typeof value === 'number'
      ? String(value)
      : typeof value === 'boolean'
      ? String(value)
      : key === 'discTitles'
      ? `${esc(JSON.stringify(value))}::JSON`
      : `[${(value as string[]).map(esc).join(', ')}]::VARCHAR[]`;
    return `${column} = ${literal}`;
  });
  await q.run(
    `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ${esc(id)}`,
  );
}
