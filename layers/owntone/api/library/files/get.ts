// layers/owntone/api/library/files/get.ts — GET /api/library/files[?directory=].
// No directory → the configured source roots (app.libraries — never a
// hat-invented folder list). A directory must be a source root or under one
// (no escape) → else 404. Directories are catalog-derived (immediate
// subdirs of scanned files); tracks = the dir's immediate media files;
// playlists: Melofon's live in DuckDB, not dirs — an honest empty paging.
import {
  albumArtistResolver,
  notFound,
  paged,
  pagingParams,
  trackPayload,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest, SongRow } from '#owntone/types.ts';

const ALL = 9007199254740991; // Largest exactly representable safe integer.

export default async (request: HatRequest, context: HatContext) => {
  const roots = (await context.app.libraries.list()).map((l) =>
    l.path.replace(/\/+$/, '')
  );
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;

  const dir = request.query.get('directory');
  if (dir === null) {
    return {
      directories: roots.map((path) => ({ path })),
      tracks: paged([], paging.offset, paging.limit),
      playlists: paged([], paging.offset, paging.limit),
    };
  }
  const target = dir.replace(/\/+$/, '');
  if (!roots.some((r) => target === r || target.startsWith(`${r}/`))) {
    return notFound();
  }

  const prefix = `${target}/`;
  const subdirs = new Set<string>();
  const tracks: SongRow[] = [];
  for (
    const song of await context.app.library.listSongs({
      offset: 0,
      size: ALL,
    })
  ) {
    if (!song.path.startsWith(prefix)) continue;
    const rest = song.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) tracks.push(song);
    else subdirs.add(`${target}/${rest.slice(0, slash)}`);
  }
  const albumArtist = albumArtistResolver(context.app);
  return {
    directories: [...subdirs].sort().map((path) => ({ path })),
    tracks: paged(
      await Promise.all(
        tracks.map(async (s) => trackPayload(s, await albumArtist(s.albumId))),
      ),
      paging.offset,
      paging.limit,
    ),
    playlists: paged([], paging.offset, paging.limit),
  };
};
