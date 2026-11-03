import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request, []);
  const row = await context.app.radio.get(request.params.id);
  if (!row) fail(404, 'not_found', 'Station not found');
  return catalogResponse(request, '', ['radio-station', 1, row.id], {
    radioStation: await browseArtwork(context).station(row),
  });
}
