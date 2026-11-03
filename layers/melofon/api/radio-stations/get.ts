import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request, []);
  const rows = await context.app.radio.list();
  return catalogResponse(request, '', ['radio-stations', 1], {
    radioStations: await Promise.all(rows.map(browseArtwork(context).station)),
  });
}
