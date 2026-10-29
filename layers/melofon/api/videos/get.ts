import type { HatContext, HatRequest } from '#melofon/types.ts';
import { namePageQuery } from '#melofon/browse.ts';
import { songDetail } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await namePageQuery(request, context);
  const page = await core(() => context.app.library.videosPage(query));
  return catalogResponse(request, page.revision, ['videos', 1, query], {
    videos: page.rows.map(songDetail),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
  });
}
