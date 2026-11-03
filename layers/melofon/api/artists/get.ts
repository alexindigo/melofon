import type { HatContext, HatRequest } from '#melofon/types.ts';
import { indexPayload, namePageQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await namePageQuery(request, context, true);
  const page = await core(() => context.app.library.artistsPage(query));
  return catalogResponse(request, page.revision, ['artists', 1, query], {
    artists: await Promise.all(page.rows.map(browseArtwork(context).artist)),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
    ...indexPayload(page.index, query.ignoredArticles),
  });
}
