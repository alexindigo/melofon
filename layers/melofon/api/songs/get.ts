import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browsePageQuery, indexPayload } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await browsePageQuery(request, context);
  const page = await core(() => context.app.library.songsPage(query));
  return catalogResponse(request, page.revision, ['songs', 1, query], {
    songs: await Promise.all(page.rows.map(browseArtwork(context).song)),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
    ...indexPayload(page.index, query.ignoredArticles),
  });
}
