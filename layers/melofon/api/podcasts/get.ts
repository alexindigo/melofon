import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request, []);
  return catalogResponse(request, '', ['podcasts', 1], {
    podcasts: await Promise.all(
      (await context.app.podcasts.channels()).map(
        browseArtwork(context).podcast,
      ),
    ),
  });
}
