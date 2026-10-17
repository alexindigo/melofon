// layers/owntone/api/library/artists/get.ts — GET /api/library/artists
// (paged artist objects; album artists only, like OwnTone).
import {
  artistPayload,
  browseArtists,
  paged,
  pagingParams,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;
  const artists = await browseArtists(context.app);
  const items = await Promise.all(
    artists.map((a) => artistPayload(context.app, a)),
  );
  return paged(items, paging.offset, paging.limit);
};
