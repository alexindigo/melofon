// Semantic catalog reads for reference matching; normalization/scoring is core's.
import { type Engine, esc } from './engine.ts';

export interface MatchArtist {
  id: string;
  name: string;
  mbid: string | null;
}
export interface MatchTrack {
  id: string;
  title: string | null;
  album: string | null;
  durationMs: number | null;
}
// Catalog rebuilds remove vanished files. Also honor an explicitly absent kept
// identity, without excluding pre-identity catalog rows during an upgrade.
const present = 'COALESCE(fi.present, true)';
export function createReferenceMatcherStore(engine: Engine) {
  return {
    artists(): Promise<MatchArtist[]> {
      return engine.exclusive((q) =>
        q.all<MatchArtist>(`
        SELECT ar.id, ar.name, ar.musicbrainz_id AS mbid FROM artists ar
        WHERE EXISTS (SELECT 1 FROM files f
          LEFT JOIN file_identity fi ON fi.id = f.id
          LEFT JOIN albums al ON al.id = f.album_id
          WHERE ${present} AND (f.artist_id = ar.id OR al.album_artist_id = ar.id))
        ORDER BY ar.id`)
      );
    },
    tracks(query: {
      recordingMbid?: string;
      isrc?: string;
      artistIds?: string[];
    }): Promise<MatchTrack[]> {
      const conditions: string[] = [];
      if (query.recordingMbid) {
        conditions.push(
          `lower(f.recording_mbid) = ${esc(query.recordingMbid.toLowerCase())}`,
        );
      }
      if (query.isrc) {
        conditions.push(`list_contains(f.isrc, ${esc(query.isrc)})`);
      }
      if (query.artistIds?.length) {
        conditions.push(
          `f.artist_id IN (${query.artistIds.map(esc).join(', ')})`,
        );
      }
      if (!conditions.length) return Promise.resolve([]);
      return engine.exclusive((q) =>
        q.all<MatchTrack>(`
        SELECT f.id, f.title, al.name AS album, f.duration_ms AS "durationMs"
        FROM files f LEFT JOIN albums al ON al.id = f.album_id
        LEFT JOIN file_identity fi ON fi.id = f.id
        WHERE ${present} AND (${conditions.join(' OR ')}) ORDER BY f.id`)
      );
    },
    genreTracks(seedId: string, count: number): Promise<string[]> {
      if (!Number.isSafeInteger(count) || count < 0) {
        return Promise.reject(new RangeError('Invalid reference count'));
      }
      return engine.exclusive(async (q) =>
        (await q.all<{ id: string }>(`
        SELECT f.id FROM files f LEFT JOIN file_identity fi ON fi.id = f.id
        WHERE ${present} AND f.id <> ${esc(seedId)} AND EXISTS (
          SELECT 1 FROM files seed LEFT JOIN file_identity si ON si.id = seed.id
          WHERE seed.id = ${esc(seedId)} AND COALESCE(si.present, true)
            AND list_has_any(f.genres, seed.genres))
        ORDER BY random() LIMIT ${count}`)).map((row) => row.id)
      );
    },
  };
}
