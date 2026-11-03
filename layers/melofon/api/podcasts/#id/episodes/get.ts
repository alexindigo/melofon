import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request, []);
  if (
    !(await context.app.podcasts.channels()).some((row) =>
      row.id === request.params.id
    )
  ) {
    fail(404, 'not_found', 'Podcast not found');
  }
  return catalogResponse(request, '', [
    'podcast-episodes',
    1,
    request.params.id,
  ], {
    episodes: await Promise.all(
      (await context.app.podcasts.episodes(request.params.id)).map(
        browseArtwork(context).episode,
      ),
    ),
  });
}
