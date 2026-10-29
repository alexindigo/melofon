// layers/opensubsonic/id3.ts — wire payload builders: ID3 artist/album, the
// legacy artist, the pre-ID3 album shape, song children, playlists, zip
// entry lists, the scan status, the favourites lists, and the
// getAlbumList/getAlbumList2 type table. Every catalog builder takes the
// response's Personal facts (personal.ts), so no call site can omit them.
// Shared module at the layer root, outside the walked mount tree.
import { fail } from '#opensubsonic/envelope.ts';
import {
  albumMetadataFields,
  songMetadataFields,
} from '#opensubsonic/metadata.ts';
import {
  boundedCountParam,
  folderIdParam,
  requiredParam,
  safeIntParam,
  yearParam,
} from '#opensubsonic/params.ts';
import {
  albumId3Fields,
  artistFields,
  childFields,
  lastStarredMs,
  loadPersonal,
  type Personal,
} from '#opensubsonic/personal.ts';
import type {
  AlbumRow,
  ArtistRow,
  HatContext,
  PlaylistRow,
  SongRow,
  StarredItem,
} from '#opensubsonic/types.ts';

export const IGNORED_ARTICLES = 'The El La Los Las Le Les Os As O A';
const ARTICLES = [
  'The',
  'El',
  'La',
  'Los',
  'Las',
  'Le',
  'Les',
  'Os',
  'As',
  'O',
  'A',
];

// SHA-256(`melofon-placeholder-artist\n${kind}`), first 32 hex characters.
const PLACEHOLDER_IDS = {
  various: '5db4f9f82609e01429419e6affafb434',
  unknown: '627a8a0ebe2d3b3284f1d4ece383dd59',
};
const PLACEHOLDER_KINDS = ['various', 'unknown'] as const;
type PlaceholderKind = typeof PLACEHOLDER_KINDS[number];

function placeholderArtist(
  kind: PlaceholderKind,
  albumCount: number,
): ArtistRow {
  const name = kind === 'various' ? '[Various Artists]' : '[Unknown Artist]';
  return { id: PLACEHOLDER_IDS[kind], name, albumCount, sortKey: name };
}

// Protocol-only artists are derived from album facts, never persisted in core.
// Every artist browse/download path resolves the same artist and membership.
export async function resolveArtist(
  context: HatContext,
  id: string,
): Promise<{ artist: ArtistRow; albums: AlbumRow[] } | null> {
  const kind = PLACEHOLDER_KINDS.find((kind) => PLACEHOLDER_IDS[kind] === id);
  if (kind !== undefined) {
    const albums = await context.app.library.albumsWithoutArtist(kind);
    return albums.length === 0
      ? null
      : { artist: placeholderArtist(kind, albums.length), albums };
  }
  const artist = await context.app.library.artistById(id);
  if (artist === null) return null;
  return { artist, albums: await context.app.library.albumsByArtist(id) };
}

export const albumLabel = (album: AlbumRow) =>
  album.name ?? `[${album.folderName}]`;
export function albumsByLabel(albums: AlbumRow[]): AlbumRow[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
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

export function artistId3Of(
  artist: ArtistRow,
  p: Personal,
): Record<string, unknown> {
  return {
    id: artist.id,
    name: artist.name,
    albumCount: artist.albumCount,
    // ArtistID3.md:52,65: supported field, empty JSON default when unknown.
    musicBrainzId: artist.musicBrainzId ?? '',
    ...artistFields(p.artist(artist.id)),
  };
}

// Legacy (folder-style) Artist: getIndexes and getStarred.
export function artistOf(
  artist: ArtistRow,
  p: Personal,
): Record<string, unknown> {
  return {
    id: artist.id,
    name: artist.name,
    ...artistFields(p.artist(artist.id)),
  };
}

// Album fields shared by the ID3 and pre-ID3 shapes, without personal facts:
// each shape adds its own field rules.
function albumBaseOf(album: AlbumRow): Record<string, unknown> {
  const artist = albumArtistLabel(album);
  return {
    id: album.id,
    name: albumLabel(album),
    artist: artist.name,
    artistId: artist.id,
    coverArt: album.id, // getCoverArt resolves album IDs
    songCount: album.songCount,
    duration: Math.round(album.durationMs / 1000),
    // Retained first observation, independent of retags/catalog rebuilds.
    created: album.createdAtMs === null
      ? undefined
      : new Date(album.createdAtMs).toISOString(),
    year: album.year ?? undefined,
  };
}

export function albumId3Of(
  album: AlbumRow,
  p: Personal,
): Record<string, unknown> {
  return {
    ...albumBaseOf(album),
    ...albumMetadataFields(album),
    ...albumId3Fields(p.album(album.id)),
  };
}

// Pre-ID3 album shape (getAlbumList / search2 / getStarred): the ID3 fields
// plus the legacy duplicates old clients read. It is a Child on the wire, so
// the Child field rules apply (userRating omitted when unset).
export function albumV1Of(
  album: AlbumRow,
  p: Personal,
): Record<string, unknown> {
  return {
    ...albumBaseOf(album),
    parent: albumArtistLabel(album).id,
    album: albumLabel(album),
    title: albumLabel(album),
    isDir: true,
    mediaType: 'album',
    ...albumMetadataFields(album),
    ...childFields(p.album(album.id)),
  };
}

// The wire `path` is relative to the song's own source root — the simulated
// Navidrome tree ("Artist/Album/01 - Song.mp3"), never the absolute path.
export function relativePathOf(song: SongRow): string {
  const root = song.libraryPath;
  return root !== null && song.path.startsWith(root)
    ? song.path.slice(root.length).replace(/^\/+/, '')
    : song.path;
}

export function childOf(song: SongRow, p: Personal): Record<string, unknown> {
  const path = relativePathOf(song);
  return {
    id: song.id,
    parent: song.albumId ?? undefined,
    created: song.firstSeenMs === null
      ? undefined
      : new Date(song.firstSeenMs).toISOString(),
    isDir: false,
    title: song.title ?? `[${song.fileName.replaceAll('_', ' ')}]`,
    album: song.albumId === null
      ? undefined
      : song.albumName ?? `[${song.albumFolderName}]`,
    artist: song.artistName ?? undefined,
    track: song.track ?? undefined,
    coverArt: song.pictureHash ? song.id : song.albumId ?? undefined,
    size: song.size ?? undefined,
    contentType: song.contentType,
    suffix: song.suffix,
    duration: song.durationMs === null
      ? undefined
      : Math.round(song.durationMs / 1000),
    genre: song.genre ?? undefined,
    year: song.year ?? undefined,
    path,
    albumId: song.albumId ?? undefined,
    artistId: song.artistId ?? undefined,
    // GenericMediaType enum: music | video | podcast | audiobook. Videos say
    // video (spec enum) — audio clients that never browse getVideos still
    // stream the same id as audio via ExtractAudio.
    type: song.isVideo ? 'video' : 'music',
    isVideo: song.isVideo,
    ...songMetadataFields(song),
    ...childFields(p.song(song.id)),
  };
}

// Playlist artwork is resolved by core through the caller's visibility check.
export function playlistOf(
  playlist: PlaylistRow,
  caller: string,
): Record<string, unknown> {
  return {
    id: playlist.id,
    name: playlist.name,
    coverArt: `pl-${playlist.id}`,
    comment: playlist.comment ?? undefined,
    owner: playlist.owner,
    public: playlist.public,
    readonly: caller !== playlist.owner,
    songCount: playlist.songCount,
    duration: Math.round(playlist.durationMs / 1000),
    created: new Date(playlist.createdAtMs).toISOString(),
    changed: new Date(playlist.changedAtMs).toISOString(),
  };
}

// Song entries of a track list (playlist, play queue): unknown tracks are
// skipped; the facts are loaded once for the resolved songs.
export async function entriesFor(
  context: HatContext,
  trackIds: string[],
): Promise<Record<string, unknown>[]> {
  const songs: SongRow[] = [];
  for (const trackId of trackIds) {
    const song = await context.app.library.getSong(trackId);
    if (song !== null) songs.push(song);
  }
  const p = await loadPersonal(context, { songs: songs.map((s) => s.id) });
  return songs.map((song) => childOf(song, p));
}

// Newest like first (the OpenSubsonic starred date); ties by id ascending.
function byLatestLike<T extends { id: string }>(
  rows: T[],
  items: StarredItem[],
): T[] {
  const liked = new Map(
    items.map((item) => [item.targetId, lastStarredMs(item.events) ?? 0]),
  );
  return [...rows].sort((a, b) =>
    (liked.get(b.id) ?? 0) - (liked.get(a.id) ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// The current user's favourites (getStarred / getStarred2), honouring
// musicFolderId: rows that no longer resolve are skipped, each list is
// newest-like first, and the facts are loaded once for all of them.
export async function starredLists(context: HatContext): Promise<{
  artists: ArtistRow[];
  albums: AlbumRow[];
  songs: SongRow[];
  personal: Personal;
}> {
  const folderId = await folderIdParam(context);
  const items = await context.app.annotation.starred(
    context.state.user!.username,
    { folderId },
  );
  const of = (type: StarredItem['targetType']) =>
    items.filter((item) => item.targetType === type);
  const songs: SongRow[] = [];
  for (const item of of('song')) {
    const song = await context.app.library.getSong(item.targetId);
    if (song !== null) songs.push(song);
  }
  const albums = await context.app.library.albumsById(
    of('album').map((item) => item.targetId),
    { folderId },
  );
  const artists: ArtistRow[] = [];
  for (const item of of('artist')) {
    const artist = await context.app.library.artistById(item.targetId);
    if (artist !== null) artists.push(artist);
  }
  const personal = await loadPersonal(context, {
    songs: songs.map((s) => s.id),
    albums: albums.map((a) => a.id),
    artists: artists.map((a) => a.id),
  });
  return {
    artists: byLatestLike(artists, items),
    albums: byLatestLike(albums, items),
    songs: byLatestLike(songs, items),
    personal,
  };
}

// Resolve an album / artist / playlist id to a zip entry list plus the
// download filename (null when the id is none of those). Entry names are
// the simulated tree paths; the filename is the entity's name, sanitized
// for Content-Disposition.
export async function zipEntriesFor(
  context: HatContext,
  id: string,
): Promise<
  { entries: { name: string; path: string }[]; filename: string } | null
> {
  const sanitize = (name: string) =>
    name.replaceAll('"', '').replaceAll(/[/\\]/g, '_');
  const entriesOf = (songs: SongRow[]) =>
    songs.map((song) => ({ name: relativePathOf(song), path: song.path }));

  const album = await context.app.library.getAlbum(id);
  if (album !== null) {
    return {
      entries: entriesOf(album.songs),
      filename: sanitize(albumLabel(album.album)),
    };
  }
  const resolved = await resolveArtist(context, id);
  if (resolved !== null && resolved.albums.length > 0) {
    const songs: SongRow[] = [];
    for (const a of resolved.albums) {
      const got = await context.app.library.getAlbum(a.id);
      if (got !== null) songs.push(...got.songs);
    }
    return {
      entries: entriesOf(songs),
      filename: sanitize(resolved.artist.name),
    };
  }
  const playlist = await context.app.playlists.get(
    context.state.user!.username,
    id,
  );
  if (playlist !== null) {
    const songs: SongRow[] = [];
    for (const trackId of playlist.trackIds) {
      const song = await context.app.library.getSong(trackId);
      if (song !== null) songs.push(song);
    }
    return { entries: entriesOf(songs), filename: sanitize(playlist.name) };
  }
  return null;
}

// Navidrome default IndexGroups; grouping reads the same core-computed key
// that ordered the artists, avoiding divergent SQL/JavaScript accent folding.
function indexName(key: string): string {
  const ch = key.charAt(0).toUpperCase();
  if (ch >= 'X' && ch <= 'Z') return 'X-Z';
  if (ch >= 'A' && ch <= 'W') return ch;
  return ch === '[' ? '[Unknown]' : '#';
}

export async function artistIndex(
  context: HatContext,
  build: typeof artistOf,
): Promise<Record<string, unknown>[]> {
  const folderId = await folderIdParam(context);
  const artists = await context.app.library.listArtists(
    folderId,
    { ignoredArticles: ARTICLES },
  );
  for (const kind of PLACEHOLDER_KINDS) {
    const albums = await context.app.library.albumsWithoutArtist(kind, {
      folderId,
    });
    if (albums.length > 0) artists.push(placeholderArtist(kind, albums.length));
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  artists.sort((a, b) =>
    compare(a.sortKey!, b.sortKey!) || compare(a.id, b.id)
  );
  const p = await loadPersonal(context, { artists: artists.map((a) => a.id) });
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const artist of artists) {
    const name = indexName(artist.sortKey!);
    const list = groups.get(name) ?? [];
    list.push(build(artist, p));
    groups.set(name, list);
  }
  return [...groups.keys()].sort().map((name) => ({
    name,
    artist: groups.get(name)!,
  }));
}

/** Navidrome's ascending indexed year, then album name and canonical id. */
export function artistAlbumsOrder(albums: AlbumRow[]): AlbumRow[] {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...albums].sort((a, b) =>
    (a.year ?? 0) - (b.year ?? 0) || compare(albumLabel(a), albumLabel(b)) ||
    compare(a.id, b.id)
  );
}

export async function scanStatusOf(
  context: HatContext,
): Promise<Record<string, unknown>> {
  const s = await context.app.scan.status();
  return {
    scanning: s.scanning,
    count: s.count,
    folderCount: s.folderCount,
    lastScan: s.lastScanMs === null
      ? undefined
      : new Date(s.lastScanMs).toISOString(),
  };
}

// getAlbumList/getAlbumList2 share the type table. Every documented type is
// implemented; unknown types get the same clean "not implemented" envelope.
// Core owns eligibility, order and paging for personal selections too.
const ALBUM_LIST_SORTS: Record<
  string,
  | 'name'
  | 'artist'
  | 'random'
  | 'newest'
  | 'starred'
  | 'highest'
  | 'frequent'
  | 'recent'
  | 'genre'
  | 'year'
> = {
  alphabeticalByName: 'name',
  alphabeticalByArtist: 'artist',
  random: 'random',
  newest: 'newest',
  starred: 'starred',
  highest: 'highest',
  frequent: 'frequent',
  recent: 'recent',
  byGenre: 'genre',
  byYear: 'year',
};

export async function albumListAlbums(
  context: HatContext,
): Promise<AlbumRow[] | Response> {
  const params = context.state.params!;
  const type = requiredParam(context, 'type');
  if (type instanceof Response) return type;
  const sort = ALBUM_LIST_SORTS[type];
  if (sort === undefined) {
    return fail(context, 0, `album list type not implemented: ${type}`);
  }
  const opts: Parameters<HatContext['app']['library']['listAlbums']>[0] = {
    sort,
    size: boundedCountParam(params, 'size'),
    offset: safeIntParam(params, 'offset', 0),
    folderId: await folderIdParam(context),
    username: context.state.user!.username,
    ignoredArticles: ARTICLES,
  };
  if (sort === 'genre') {
    const genre = requiredParam(context, 'genre');
    if (genre instanceof Response) return genre;
    opts.genre = genre;
  }
  if (sort === 'year') {
    // Spec: fromYear/toYear are required for byYear; from > to is reverse
    // chronological.
    const fromYear = requiredParam(context, 'fromYear');
    if (fromYear instanceof Response) return fromYear;
    const toYear = requiredParam(context, 'toYear');
    if (toYear instanceof Response) return toYear;
    const from = yearParam(context, 'fromYear');
    if (from instanceof Response) return from;
    const to = yearParam(context, 'toYear');
    if (to instanceof Response) return to;
    opts.fromYear = from;
    opts.toYear = to;
  }
  return await context.app.library.listAlbums(opts);
}
