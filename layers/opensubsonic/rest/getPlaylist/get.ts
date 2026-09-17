// layers/opensubsonic/rest/getPlaylist/get.ts — GET /rest/getPlaylist.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { entriesFor, playlistOf } from '#opensubsonic/id3.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const username = context.state.user!.username;
  const playlist = await context.app.playlists.get(username, id);
  if (playlist === null) return notFound(context);
  return ok(context, {
    playlist: {
      ...playlistOf(playlist, username),
      entry: await entriesFor(context, playlist.trackIds),
    },
  });
};
