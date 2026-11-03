import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request, []);
  const row = await context.app.podcasts.episode(request.params.id);
  if (!row) fail(404, 'not_found', 'Episode not found');
  return catalogResponse(request, '', ['podcast-episode', 1, row.id], {
    episode: await browseArtwork(context).episode(row),
  });
}
