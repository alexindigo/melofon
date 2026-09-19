// layers/owntone/api/library/albums/get.ts — GET /api/library/albums:
// { items, total, offset, limit }. M5 thin library: the full list is fetched
// and sliced in the hat (app.library has no count query).
import { albumPayload, paged, pagingParams } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;
  const albums = await context.app.library.listAlbums({
    sort: 'name',
    size: Number.MAX_SAFE_INTEGER,
    offset: 0,
  });
  return paged(albums.map(albumPayload), paging.offset, paging.limit);
};
