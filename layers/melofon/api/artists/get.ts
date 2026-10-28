import type { HatContext, HatRequest } from '#melofon/types.ts';
import { artistPageQuery } from '#melofon/browse.ts';
import { artistSummary } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await artistPageQuery(request, context);
  const page = await core(() => context.app.library.artistsPage(query));
  return catalogResponse(request, page.revision, ['artists', 1, query], {
    artists: page.rows.map(artistSummary),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
  });
}
