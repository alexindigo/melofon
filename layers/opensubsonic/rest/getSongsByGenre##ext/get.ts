// layers/opensubsonic/rest/getSongsByGenre/get.ts — GET
// /rest/getSongsByGenre.
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import {
  folderIdParam,
  intParam,
  requiredParam,
} from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const genre = requiredParam(context, 'genre');
  if (genre instanceof Response) return genre;
  const songs = await context.app.library.songsByGenre(genre, {
    size: intParam(params, 'count', 10),
    offset: intParam(params, 'offset', 0),
    folderId: await folderIdParam(context),
  });
  return ok(context, { songsByGenre: { song: songs.map(childOf) } });
};
