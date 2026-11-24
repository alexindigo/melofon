// layers/opensubsonic/rest/getSongsByGenre/get.ts — GET
// /rest/getSongsByGenre.
import { ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import {
  boundedCountParam,
  folderIdParam,
  requiredParam,
  safeIntParam,
} from '#opensubsonic/params.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const genre = requiredParam(context, 'genre');
  if (genre instanceof Response) return genre;
  const folderId = await folderIdParam(context);
  if (folderId instanceof Response) return folderId;
  const songs = await context.app.library.songsByGenre(genre, {
    size: boundedCountParam(params, 'count'),
    offset: safeIntParam(params, 'offset', 0),
    folderId,
  });
  const p = await loadPersonal(context, {
    songs: songs.map((song) => song.id),
  });
  return ok(context, {
    songsByGenre: { song: songs.map((song) => childOf(song, p)) },
  });
};
