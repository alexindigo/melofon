// layers/opensubsonic/rest/deletePlaylist/get.ts — GET /rest/deletePlaylist.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const deleted = await context.app.playlists.delete(
    context.state.user!.username,
    id,
  );
  if (!deleted) return notFound(context);
  return ok(context, {});
};
