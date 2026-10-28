import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseLibrary, browseQuery } from '#melofon/browse.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const library = browseLibrary(browseQuery(request, ['library']));
  const snapshot = await core(() => context.app.library.statistics(library));
  const stats = snapshot.statistics;
  return catalogResponse(
    request,
    snapshot.revision,
    ['statistics', 1, library],
    {
      statistics: {
        songCount: stats.songCount,
        videoCount: stats.videoCount,
        durationMs: stats.durationMs,
        albumCount: stats.albumCount,
        artistCount: stats.artistCount,
        browseArtistCount: stats.browseArtistCount,
      },
    },
  );
}
