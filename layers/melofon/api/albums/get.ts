import type { HatContext, HatRequest } from '#melofon/types.ts';
import { albumPageQuery } from '#melofon/browse.ts';
import { albumSummary } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await albumPageQuery(request, context);
  const page = await core(() => context.app.library.albumsPage(query));
  return catalogResponse(request, page.revision, ['albums', 1, query], {
    albums: page.rows.map(albumSummary),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
  });
}
