// layers/opensubsonic/rest/getSong/get.ts — GET /rest/getSong.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { childOf } from '#opensubsonic/id3.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { loadPersonal } from '#opensubsonic/personal.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const song = await context.app.library.getSong(id);
  if (song === null) return notFound(context);
  const p = await loadPersonal(context, { songs: [song.id] });
  return ok(context, { song: childOf(song, p) });
};
