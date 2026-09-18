// layers/opensubsonic/rest/getRandomSongs/get.ts — GET /rest/getRandomSongs.
// Pull-forward for Symfonium: random songs from the catalog. genre/year
// filters are not implemented in M2.
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import { folderIdParam, intParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const songs = await context.app.library.randomSongs(
    intParam(params, 'size', 10),
    await folderIdParam(context),
  );
  return ok(context, {
    randomSongs: {
      song: songs.map((song) => childOf(song)),
    },
  });
};
