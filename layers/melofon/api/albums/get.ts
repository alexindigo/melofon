import type { HatContext, HatRequest } from '#melofon/types.ts';
import {
  browsePageQuery,
  indexPayload,
  personalAlbumSort,
} from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await browsePageQuery(request, context, 'albums');
  const page = await core(() => context.app.library.albumsPage(query));
  const body = {
    albums: await Promise.all(page.rows.map(browseArtwork(context).album)),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
    ...indexPayload(page.index, query.ignoredArticles),
  };
  if (personalAlbumSort(query.sort)) {
    return Response.json(body, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }
  return catalogResponse(request, page.revision, ['albums', 1, query], body);
}
