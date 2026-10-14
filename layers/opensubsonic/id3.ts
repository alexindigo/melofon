// layers/opensubsonic/id3.ts — wire payload builders: ID3 artist/album, the
// pre-ID3 album shape, song children, playlists, zip entry lists, the scan
// status, and the getAlbumList/getAlbumList2 type table. Shared module at
// the layer root, outside the walked mount tree.
import { fail } from '#opensubsonic/envelope.ts';
import {
  boundedCountParam,
  folderIdParam,
  requiredParam,
  safeIntParam,
  yearParam,
} from '#opensubsonic/params.ts';
import type {
  AlbumRow,
  ArtistRow,
  HatContext,
  PlaylistRow,
  SongRow,
} from '#opensubsonic/types.ts';

export const IGNORED_ARTICLES = 'The El La Los Las Le Les';

export function artistId3Of(artist: ArtistRow): Record<string, unknown> {
  return {
    id: artist.id,
    name: artist.name,
    albumCount: artist.albumCount,
  };
}

export function albumId3Of(album: AlbumRow): Record<string, unknown> {
  return {
    id: album.id,
    name: album.name,
    artist: album.artistName,
    artistId: album.artistId,
    coverArt: album.id, // getCoverArt resolves album IDs
    songCount: album.songCount,
    duration: Math.round(album.durationMs / 1000),
    // Required by the OpenSubsonic schema: "date the album was added" — the
    // newest file mtime stands in for it (the catalog rebuild makes a
    // row-creation time meaningless).
    created: album.createdAtMs === null
      ? undefined
      : new Date(album.createdAtMs).toISOString(),
    year: album.year ?? undefined,
  };
}

// Pre-ID3 album shape (getAlbumList / search2): the ID3 fields plus the
// legacy duplicates old clients read.
export function albumV1Of(album: AlbumRow): Record<string, unknown> {
  return {
    ...albumId3Of(album),
    album: album.name,
    title: album.name,
    isDir: true,
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

export function childOf(song: SongRow): Record<string, unknown> {
  const path = relativePathOf(song);
  return {
    id: song.id,
    isDir: false,
    title: song.title,
    album: song.albumName ?? undefined,
    artist: song.artistName ?? undefined,
    track: song.track ?? undefined,
    coverArt: song.albumId ?? undefined,
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
  };
}

// Subsonic playlist payload. No coverArt: getCoverArt does not resolve
// playlist IDs in M2. `public` is always false (single-household server).
export function playlistOf(
  playlist: PlaylistRow,
  owner: string,
): Record<string, unknown> {
  return {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment ?? undefined,
    owner,
    public: false,
    songCount: playlist.songCount,
    duration: Math.round(playlist.durationMs / 1000),
    created: new Date(playlist.createdAtMs).toISOString(),
    changed: new Date(playlist.changedAtMs).toISOString(),
  };
}

export async function entriesFor(
  context: HatContext,
  trackIds: string[],
): Promise<Record<string, unknown>[]> {
  const entries: Record<string, unknown>[] = [];
  for (const trackId of trackIds) {
    const song = await context.app.library.getSong(trackId);
    if (song !== null) {
      entries.push(childOf(song));
    }
  }
  return entries;
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
      filename: sanitize(album.album.name),
    };
  }
  const artist = await context.app.library.getArtist(id);
  if (artist !== null) {
    const songs: SongRow[] = [];
    for (const a of await context.app.library.albumsByArtist(id)) {
      const got = await context.app.library.getAlbum(a.id);
      if (got !== null) songs.push(...got.songs);
    }
    return { entries: entriesOf(songs), filename: sanitize(artist.name) };
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

export function indexName(name: string): string {
  const ch = name.charAt(0).toUpperCase();
  return ch >= 'A' && ch <= 'Z' ? ch : '#';
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
