import type { HatContext, HatRequest } from '#melofon/types.ts';
import { namePageQuery } from '#melofon/browse.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await namePageQuery(request, context);
  const page = await core(() => context.app.library.genresPage(query));
  return catalogResponse(request, page.revision, ['genres', 1, query], {
    genres: page.rows.map((genre) => ({
      name: genre.name,
      songCount: genre.songCount,
      albumCount: genre.albumCount,
    })),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
  });
}
