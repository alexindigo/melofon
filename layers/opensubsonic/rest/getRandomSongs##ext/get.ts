// layers/opensubsonic/rest/getRandomSongs/get.ts — GET /rest/getRandomSongs.
// Candidate predicates compose in core before sampling.
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import {
  boundedCountParam,
  folderIdParam,
  yearParam,
} from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const fromYear = yearParam(context, 'fromYear');
  if (fromYear instanceof Response) return fromYear;
  const toYear = yearParam(context, 'toYear');
  if (toYear instanceof Response) return toYear;
  const songs = await context.app.library.randomSongs({
    size: boundedCountParam(params, 'size'),
    folderId: await folderIdParam(context),
    genre: params.get('genre') ?? undefined,
    fromYear,
    toYear,
  });
  return ok(context, {
    randomSongs: {
      song: songs.map((song) => childOf(song)),
    },
  });
};
