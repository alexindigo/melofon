// layers/owntone/api/library/genres/get.ts — GET /api/library/genres:
// browse-info paging ({ name } only, like the docs example).
import { paged, pagingParams } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const paging = pagingParams(request.query);
  if (paging instanceof Response) return paging;
  const genres = await context.app.library.listGenres();
  return paged(
    genres.map((g) => ({ name: g.name })),
    paging.offset,
    paging.limit,
  );
};
