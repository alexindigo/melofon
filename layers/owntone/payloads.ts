// layers/owntone/payloads.ts — OwnTone wire shapes and the id boundary.
// Storage ids are 32-hex content hashes; the OwnTone wire wants integer
// library ids (its route regexes are [[:digit:]]+). The hat maps at the
// boundary with a stable hash-derived int31 — the same formula as
// OpenSubsonic's folderWireId. Queue item `id` is a queue-local int;
// `track_id` on the item is the library (wire) id.
import { legacyInteger } from './numbers.ts';
import type {
  AlbumRow,
  ArtistRow,
  CommandSourceRow,
  HatContext,
  HatRequest,
  OutputRow,
  PlaylistRow,
  QueueEntryRow,
  SongRow,
} from './types.ts';

export function wireInt(hash: string): number {
  return Number(BigInt(`0x${hash.slice(0, 8)}`) & 0x7fffffffn);
}

/** Provenance for a mutating command (plan command-provenance): the
 * request's peer + user-agent + X-Melofon-Client, recorded by the core
 * as lastCommand and logged as one [cmd] line. Structural mirror of
 * core's sourceFromRequest (hats never import src/). */
export function sourceFrom(request: HatRequest): CommandSourceRow {
  const userAgent = request.headers.get('user-agent') ?? undefined;
  const client = request.headers.get('x-melofon-client')?.trim();
  return {
    kind: 'http',
    ...(request.remoteAddr?.hostname !== undefined
      ? { peer: request.remoteAddr.hostname }
      : {}),
    ...(userAgent !== undefined ? { userAgent: userAgent.slice(0, 80) } : {}),
    ...(client ? { client: client.slice(0, 80) } : {}),
  };
}

const ALL = Number.MAX_SAFE_INTEGER;

const placeholderId = async (kind: string) => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`melofon-placeholder-artist\n${kind}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0'))
    .join('').slice(0, 32);
};
const PLACEHOLDER_IDS = {
  various: await placeholderId('various'),
  unknown: await placeholderId('unknown'),
};
const PLACEHOLDER_KINDS = ['various', 'unknown'] as const;
type PlaceholderKind = typeof PLACEHOLDER_KINDS[number];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function placeholderArtist(
  kind: PlaceholderKind,
  albumCount: number,
): ArtistRow {
  return {
    id: PLACEHOLDER_IDS[kind],
    name: kind === 'various' ? '[Various Artists]' : '[Unknown Artist]',
    albumCount,
  };
}

/** Protocol-only artist membership. All artist browse/queue/payload paths
 * use this boundary, so placeholder ids never reach real-artist queries. */
export function artistAlbums(app: HatContext['app'], id: string) {
  const kind = PLACEHOLDER_KINDS.find((kind) => PLACEHOLDER_IDS[kind] === id);
  return kind === undefined
    ? app.library.albumsByArtist(id)
    : app.library.albumsWithoutArtist(kind);
}

/** Artist roots and statistics share the same derived set. A placeholder
 * exists only while at least one album has that artist kind. */
export async function browseArtists(
  app: HatContext['app'],
): Promise<ArtistRow[]> {
  const artists = [...await app.library.listArtists()];
  for (const kind of PLACEHOLDER_KINDS) {
    const albums = await artistAlbums(app, PLACEHOLDER_IDS[kind]);
    if (albums.length > 0) artists.push(placeholderArtist(kind, albums.length));
  }
  return artists.sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));
}

export const albumLabel = (album: AlbumRow) =>
  album.name ?? `[${album.folderName}]`;
export function albumsByLabel(albums: AlbumRow[]): AlbumRow[] {
  return [...albums].sort((a, b) =>
    compare(albumLabel(a), albumLabel(b)) || compare(a.id, b.id)
  );
}
export function albumArtistLabel(
  album: AlbumRow,
): { id: string; name: string } {
  if (album.artistKind === 'various' || album.artistKind === 'unknown') {
    const { id, name } = placeholderArtist(album.artistKind, 0);
    return { id, name };
  }
  return { id: album.artistId!, name: album.artistName! };
}

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

/** Wire int → song row (null when unknown or not digits). listSongs with a
 * ceiling size is the catalog walk — stable path order, so wire→song
 * resolution is deterministic. */
export async function findSongByWire(
  app: HatContext['app'],
  wire: string,
): Promise<SongRow | null> {
  if (!/^\d+$/.test(wire)) return null;
  const n = Number(wire);
  const songs = await app.library.listSongs({ offset: 0, size: ALL });
  return songs.find((s) => wireInt(s.id) === n) ?? null;
}

/** Wire int → artist row (null when unknown or not digits). */
export async function findArtistByWire(
  app: HatContext['app'],
  wire: string,
): Promise<ArtistRow | null> {
  if (!/^\d+$/.test(wire)) return null;
  const n = Number(wire);
  const artists = await browseArtists(app);
  return artists.find((a) => wireInt(a.id) === n) ?? null;
}

/** Wire int → playlist row for the seeded user (null when unknown, not
 * digits, or no user configured). */
export async function findPlaylistByWire(
  app: HatContext['app'],
  wire: string,
): Promise<PlaylistRow | null> {
  if (!/^\d+$/.test(wire) || app.cfg.user === undefined) return null;
  const n = Number(wire);
  const playlists = await app.playlists.list(app.cfg.user);
  return playlists.find((p) => wireInt(p.id) === n) ?? null;
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
        got === null ? null : albumArtistLabel(got.album),
      );
    }
    return cache.get(albumId) ?? null;
  };
}

export function albumPayload(album: AlbumRow) {
  const artist = albumArtistLabel(album);
  return {
    id: String(wireInt(album.id)),
    name: albumLabel(album),
    name_sort: albumLabel(album), // the catalog keeps no sort names
    artist: artist.name,
    artist_id: String(wireInt(artist.id)),
    track_count: album.songCount,
    length_ms: album.durationMs,
    uri: `library:album:${wireInt(album.id)}`,
    artwork_url: `./artwork/group/${wireInt(album.id)}`,
  };
}

export function trackPayload(
  song: SongRow,
  albumArtist: { id: string; name: string } | null,
) {
  const artist = song.artistName ??
    (song.albumId === null ? '' : placeholderArtist('unknown', 0).name);
  return {
    id: wireInt(song.id),
    title: song.title ?? `[${song.fileName.replaceAll('_', ' ')}]`,
    artist,
    artist_sort: artist,
    ...(song.albumId !== null && {
      album: song.albumName ?? `[${song.albumFolderName}]`,
      album_sort: song.albumName ?? `[${song.albumFolderName}]`,
    }),
    ...(song.albumId !== null && { album_id: String(wireInt(song.albumId)) }),
    album_artist: albumArtist?.name ?? artist,
    album_artist_sort: albumArtist?.name ?? artist,
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
    artwork_url: `./artwork/item/${wireInt(song.id)}`,
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
    requires_auth: output.requiresAuth ?? false,
    needs_auth_key: output.needsAuthKey ?? false,
    volume: output.volume,
    offset_ms: 0,
    format: 'pcm',
    supported_formats: ['pcm'],
  };
}

/** OwnTone artist object. track_count/length_ms are summed over the artist's
 * albums in the hat (app.library has no per-artist aggregate — thin, N+1 by
 * design at this slice's scale). */
export async function artistPayload(
  app: HatContext['app'],
  artist: ArtistRow,
) {
  const albums = await artistAlbums(app, artist.id);
  return {
    id: String(wireInt(artist.id)),
    name: artist.name,
    name_sort: artist.name, // the catalog keeps no sort names
    album_count: artist.albumCount,
    track_count: albums.reduce((n, a) => n + a.songCount, 0),
    length_ms: albums.reduce((n, a) => n + a.durationMs, 0),
    uri: `library:artist:${wireInt(artist.id)}`,
    // Artist tile: the first album's cover stands in (omitted with no albums).
    ...(albums.length > 0 && {
      artwork_url: `./artwork/group/${wireInt(albums[0].id)}`,
    }),
  };
}

/** OwnTone playlist object (plain only — no smart playlists, no folders).
 * `id` is a number like theirs; `path` carries the name (Melofon playlists
 * have no file path). */
export function playlistPayload(playlist: PlaylistRow) {
  return {
    id: wireInt(playlist.id),
    name: playlist.name,
    path: playlist.name,
    parent_id: 0,
    type: 'plain',
    smart_playlist: false,
    random: false,
    folder: false,
    item_count: playlist.songCount,
    stream_count: 0,
    uri: `library:playlist:${wireInt(playlist.id)}`,
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
  return value === null ? null : legacyInteger(value);
}

/** OwnTone paging params: offset ≥ 0, limit ≥ -1 (-1 = all). 400 on junk. */
export function pagingParams(
  query: URLSearchParams,
): { offset: number; limit: number } | Response {
  const rawOffset = query.get('offset');
  const rawLimit = query.get('limit');
  const offset = rawOffset === null ? 0 : intParam(rawOffset);
  const limit = rawLimit === null ? -1 : intParam(rawLimit);
  if (offset === null || limit === null || offset < 0 || limit < -1) {
    return badRequest();
  }
  return { offset, limit };
}

/** OwnTone paging object: { items, total, offset, limit }. The caller passes
 * the FULL list (thin slice: no count queries in app.library). */
export function paged<T>(all: T[], offset: number, limit: number) {
  return {
    items: limit === -1 ? all.slice(offset) : all.slice(offset, offset + limit),
    total: all.length,
    offset,
    limit,
  };
}
