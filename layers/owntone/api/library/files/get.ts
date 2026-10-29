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
import type { HatContext, HatRequest } from '#owntone/types.ts';

const ALL = 9007199254740991; // Largest exactly representable safe integer.

export default async (request: HatRequest, context: HatContext) => {
  const roots = (await context.app.libraries.list()).map((l) => ({
    id: l.id,
    path: l.path.replace(/\/+$/, ''),
  }));
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;

  const dir = request.query.get('directory');
  if (dir === null) {
    return {
      directories: roots.map(({ path }) => ({ path })),
      tracks: paged([], paging.offset, paging.limit),
      playlists: paged([], paging.offset, paging.limit),
    };
  }
  const target = dir.replace(/\/+$/, '');
  const root = roots.find((r) =>
    target === r.path || target.startsWith(`${r.path}/`)
  );
  if (!root) return notFound();
  let page;
  try {
    page = await context.app.folders.browse({
      libraryId: root.id,
      path: target === root.path ? '' : target.slice(root.path.length + 1),
      // Directories are an unpaged array in OwnTone. Only immediate tracks
      // carry paging; keep legacy zero/all/unsafe integer wire values while
      // passing canonical safe pages to core.
      folders: { offset: 0, limit: ALL },
      songs: {
        offset: Math.min(paging.offset, ALL),
        limit: paging.limit === -1
          ? ALL
          : Math.max(1, Math.min(paging.limit, ALL)),
      },
    });
  } catch (error) {
    // Historically any absent/noncanonical in-root directory returned empty
    // pages, not a native folder error. Never normalize it into another path.
    if (
      !(error instanceof Error) || error.name !== 'LibraryError' ||
      !('code' in error) ||
      (error.code !== 'not_found' && error.code !== 'invalid_field')
    ) throw error;
    return {
      directories: [],
      tracks: paged([], paging.offset, paging.limit),
      playlists: paged([], paging.offset, paging.limit),
    };
  }
  const albumArtist = albumArtistResolver(context.app);
  return {
    // This array is unpaged; retain the hat's UTF-16 path order even where
    // core's binary text order differs (astral versus high-BMP names).
    directories: page.folders.rows.map((f) => `${root.path}/${f.path}`).sort()
      .map((path) => ({ path })),
    tracks: {
      items: await Promise.all(
        (paging.limit === 0 ? [] : page.songs.rows).map(async (s) =>
          trackPayload(s, await albumArtist(s.albumId))
        ),
      ),
      total: page.songs.total,
      offset: paging.offset,
      limit: paging.limit,
    },
    playlists: paged([], paging.offset, paging.limit),
  };
};
