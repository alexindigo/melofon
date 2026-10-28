import type { HatContext, HatRequest } from '#melofon/types.ts';
import { namePageQuery } from '#melofon/browse.ts';
import { albumSummary, artistReference } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core, fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await namePageQuery(request, context);
  const page = await core(() =>
    context.app.library.artistAlbumsPage(
      artistReference(request.params.id),
      query,
    )
  );
  if (page.artist === null) fail(404, 'not_found', 'Artist not found');
  return catalogResponse(request, page.revision, [
    'artist-albums',
    1,
    request.params.id,
    query,
  ], {
    albums: page.rows.map(albumSummary),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
  });
}
