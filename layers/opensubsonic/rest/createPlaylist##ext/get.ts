// layers/opensubsonic/rest/createPlaylist/get.ts — GET /rest/createPlaylist.
// With `playlistId`: replace that playlist's tracks. With `name`: create.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { entriesFor, playlistOf } from '#opensubsonic/id3.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const username = context.state.user!.username;
  const trackIds = params.getAll('songId');
  const playlistId = params.get('playlistId');
  if (playlistId !== null && playlistId !== '') {
    const updated = await context.app.playlists.setTracks(
      username,
      playlistId,
      trackIds,
    );
    if (updated === null) return notFound(context);
    return ok(context, {
      playlist: {
        ...playlistOf(updated, username),
        entry: await entriesFor(context, updated.trackIds),
      },
    });
  }
  const name = requiredParam(context, 'name');
  if (name instanceof Response) return name;
  const created = await context.app.playlists.create(
    username,
    name,
    trackIds,
  );
  return ok(context, {
    playlist: {
      ...playlistOf(created, username),
      entry: await entriesFor(context, created.trackIds),
    },
  });
};
