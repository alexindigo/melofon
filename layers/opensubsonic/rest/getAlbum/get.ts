// layers/opensubsonic/rest/getAlbum/get.ts — GET /rest/getAlbum.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { albumId3Of, childOf } from '#opensubsonic/id3.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const got = await context.app.library.getAlbum(id);
  if (got === null) return notFound(context);
  return ok(context, {
    album: {
      ...albumId3Of(got.album),
      song: got.songs.map((song) => childOf(song)),
    },
  });
};
