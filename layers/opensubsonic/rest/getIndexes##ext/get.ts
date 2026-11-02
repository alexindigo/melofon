// layers/opensubsonic/rest/getIndexes/get.ts — GET /rest/getIndexes.
// Simulated browse-by-folder (Navidrome: "no plans to support
// browse-by-folder… returns a simulated directory tree, using the format
// /Artist/Album/01 - Song.mp3"). There is no folders table: top-level
// directories are the album artists (same set as getArtists), directory
// ids use the real artist/album ids or the plugin's placeholder artist ids.
// Every scanned song has an album, including untagged directory albums, so
// every song is in the tree. No shortcuts, no top-level child elements.
import { ok } from '#opensubsonic/envelope.ts';
import { artistIndex, artistOf } from '#opensubsonic/id3.ts';
import { safeIntParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const scan = await context.app.scan.status();
  const lastModified = scan.lastScanStartedMs ?? 0;
  const since = safeIntParam(context.state.params!, 'ifModifiedSince', 0);
  const { ignoredArticles } = await context.app.library.order();
  return ok(context, {
    indexes: {
      // Same snapshot supplies the advertised words and the core index keys.
      ignoredArticles: ignoredArticles.join(' '),
      lastModified,
      index: since >= lastModified
        ? undefined
        : await artistIndex(context, artistOf, ignoredArticles),
    },
  });
};
