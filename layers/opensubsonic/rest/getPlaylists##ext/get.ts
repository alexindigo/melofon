// layers/opensubsonic/rest/getPlaylists/get.ts — GET /rest/getPlaylists.
import { fail, notFound, ok } from '#opensubsonic/envelope.ts';
import { playlistOf } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const username = context.state.user!.username;
  const rows = await context.app.playlists.visible(
    username,
    context.state.params!.get('username') ?? undefined,
  );
  if (rows === 'forbidden') {
    return fail(context, 50, 'User is not authorized for the given operation');
  }
  if (rows === null) return notFound(context);
  return ok(context, {
    playlists: { playlist: rows.map((p) => playlistOf(p, username)) },
  });
};
