import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request, []);
  const row = (await context.app.podcasts.channels()).find((row) =>
    row.id === request.params.id
  );
  if (!row) fail(404, 'not_found', 'Podcast not found');
  return catalogResponse(request, '', ['podcast', 1, row.id], {
    podcast: await browseArtwork(context).podcast(row),
  });
}
