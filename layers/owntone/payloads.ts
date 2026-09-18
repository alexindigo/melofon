// layers/owntone/payloads.ts — OwnTone wire shapes and the id boundary.
// Storage ids are 32-hex content hashes; the OwnTone wire wants integer
// library ids (its route regexes are [[:digit:]]+). The hat maps at the
// boundary with a stable hash-derived int31 — the same formula as
// OpenSubsonic's folderWireId. Queue item `id` is a queue-local int;
// `track_id` on the item is the library (wire) id.
import type {
  AlbumRow,
  HatContext,
  OutputRow,
  QueueEntryRow,
  SongRow,
} from './types.ts';

export function wireInt(hash: string): number {
  return Number(BigInt(`0x${hash.slice(0, 8)}`) & 0x7fffffffn);
}

const ALL = Number.MAX_SAFE_INTEGER;

/** Wire int → album row (null when unknown or not digits). The catalog has
 * no by-wire-int index: list and match, like OpenSubsonic's folderIdParam. */
export async function findAlbumByWire(
  app: HatContext['app'],
  wire: string,
): Promise<AlbumRow | null> {
  if (!/^\d+$/.test(wire)) return null;
  const n = Number(wire);
  const albums = await app.library.listAlbums({
    sort: 'name',
    size: ALL,
    offset: 0,
  });
  return albums.find((a) => wireInt(a.id) === n) ?? null;
}

/** Wire int → song row (null when unknown or not digits). randomSongs with a
 * ceiling size is the all-songs scan (app.library has no list-all). */
export async function findSongByWire(
  app: HatContext['app'],
  wire: string,
): Promise<SongRow | null> {
  if (!/^\d+$/.test(wire)) return null;
  const n = Number(wire);
  const songs = await app.library.randomSongs(ALL);
  return songs.find((s) => wireInt(s.id) === n) ?? null;
}

/** Album artist for payload building, cached per request (one getAlbum per
 * unique album id). */
export function albumArtistResolver(app: HatContext['app']) {
  const cache = new Map<string, { id: string; name: string } | null>();
  return async (albumId: string | null) => {
    if (albumId === null) return null;
    if (!cache.has(albumId)) {
      const got = await app.library.getAlbum(albumId);
      cache.set(
        albumId,
        got === null
          ? null
          : { id: got.album.artistId, name: got.album.artistName },
      );
    }
    return cache.get(albumId) ?? null;
  };
}

export function albumPayload(album: AlbumRow) {
  return {
    id: String(wireInt(album.id)),
    name: album.name,
    name_sort: album.name, // the catalog keeps no sort names
    artist: album.artistName,
    artist_id: String(wireInt(album.artistId)),
    track_count: album.songCount,
    length_ms: album.durationMs,
    uri: `library:album:${wireInt(album.id)}`,
  };
}

export function trackPayload(
  song: SongRow,
  albumArtist: { id: string; name: string } | null,
) {
  return {
    id: wireInt(song.id),
    title: song.title,
    artist: song.artistName ?? '',
    artist_sort: song.artistName ?? '',
    ...(song.albumName !== null && {
      album: song.albumName,
      album_sort: song.albumName,
    }),
    ...(song.albumId !== null && { album_id: String(wireInt(song.albumId)) }),
    album_artist: albumArtist?.name ?? song.artistName ?? '',
    album_artist_sort: albumArtist?.name ?? song.artistName ?? '',
    ...(albumArtist !== null && {
      album_artist_id: String(wireInt(albumArtist.id)),
    }),
    ...(song.genre !== null && { genre: song.genre }),
    year: song.year ?? 0,
    track_number: song.track ?? 0,
    disc_number: song.disc ?? 0,
    length_ms: song.durationMs ?? 0,
    media_kind: song.isVideo ? 'musicvideo' : 'music',
    data_kind: 'file',
    path: song.path,
    uri: `library:track:${wireInt(song.id)}`,
  };
}

export function queueItemPayload(
  entry: QueueEntryRow,
  position: number,
  albumArtist: { id: string; name: string } | null,
) {
  return {
    // trackPayload first: its `id` is the library wire id — the queue item's
    // own `id` is queue-local and must win.
    ...trackPayload(entry.song, albumArtist),
    id: entry.id,
    position,
    track_id: wireInt(entry.song.id),
  };
}

export function outputPayload(output: OutputRow) {
  return {
    id: output.id,
    name: output.name,
    type: output.type,
    selected: output.selected,
    has_password: false,
    requires_auth: false,
    needs_auth_key: false,
    volume: output.volume,
    offset_ms: 0,
    format: 'pcm',
    supported_formats: ['pcm'],
  };
}

// --- Small shared bits for the route files ---

export const noContent = () => new Response(null, { status: 204 });

export const badRequest = () => new Response(null, { status: 400 });

export const notFound = () => new Response(null, { status: 404 });

export const internalError = () => new Response(null, { status: 500 });

/** OwnTone boolean query params: exactly "true" is true, anything else false. */
export function boolParam(value: string | null): boolean {
  return value === 'true';
}

/** Integer query param; null when missing or not an integer. */
export function intParam(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}
