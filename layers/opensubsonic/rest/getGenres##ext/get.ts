// layers/opensubsonic/rest/getGenres/get.ts — GET /rest/getGenres.
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const genres = await context.app.library.listGenres();
  return ok(context, {
    genres: {
      genre: genres.map((g) => ({
        value: g.name,
        songCount: g.songCount,
        albumCount: g.albumCount,
      })),
    },
  });
};
