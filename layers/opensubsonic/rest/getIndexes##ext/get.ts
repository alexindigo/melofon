// layers/opensubsonic/rest/getIndexes/get.ts — GET /rest/getIndexes.
// Simulated browse-by-folder (Navidrome: "no plans to support
// browse-by-folder… returns a simulated directory tree, using the format
// /Artist/Album/01 - Song.mp3"). There is no folders table: top-level
// directories are the album artists (same set as getArtists), directory
// ids borrow the real artist/album ids. Songs with no album tag are not
// in the tree (no Album dir to hang them under) — they stay reachable via
// search3/getSong/stream. No shortcuts, no top-level child elements.
import { ok } from '#opensubsonic/envelope.ts';
import { artistIndex, artistOf, IGNORED_ARTICLES } from '#opensubsonic/id3.ts';
import { safeIntParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const scan = await context.app.scan.status();
  const lastModified = scan.lastScanStartedMs ?? 0;
  const since = safeIntParam(context.state.params!, 'ifModifiedSince', 0);
  return ok(context, {
    indexes: {
      ignoredArticles: IGNORED_ARTICLES,
      lastModified,
      index: since >= lastModified
        ? undefined
        : await artistIndex(context, artistOf),
    },
  });
};
