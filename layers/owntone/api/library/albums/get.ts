// layers/owntone/api/library/albums/get.ts — GET /api/library/albums:
// { items, total, offset, limit }. M5 thin library: the full list is fetched
// and sliced in the hat (app.library has no count query).
import { albumPayload, badRequest, intParam } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const rawOffset = request.query.get('offset');
  const rawLimit = request.query.get('limit');
  const offset = rawOffset === null ? 0 : intParam(rawOffset);
  const limit = rawLimit === null ? -1 : intParam(rawLimit);
  if (offset === null || limit === null || offset < 0 || limit < -1) {
    return badRequest();
  }
  const albums = await context.app.library.listAlbums({
    sort: 'name',
    size: Number.MAX_SAFE_INTEGER,
    offset: 0,
  });
  const page = limit === -1
    ? albums.slice(offset)
    : albums.slice(offset, offset + limit);
  return {
    items: page.map(albumPayload),
    total: albums.length,
    offset,
    limit,
  };
};
