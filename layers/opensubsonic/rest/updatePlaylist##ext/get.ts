// layers/opensubsonic/rest/updatePlaylist/get.ts — GET /rest/updatePlaylist.
import { notFound, ok } from '#opensubsonic/envelope.ts';
import { integerParam, requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const playlistId = requiredParam(context, 'playlistId');
  if (playlistId instanceof Response) return playlistId;
  const removeAtPositions = params.getAll('songIndexToRemove')
    .map(integerParam)
    .filter((n): n is number => n !== null && n >= 0);
  const updated = await context.app.playlists.update(
    context.state.user!.username,
    playlistId,
    {
      name: params.get('name') ?? undefined,
      comment: params.get('comment') ?? undefined,
      addTrackIds: params.getAll('songIdToAdd'),
      removeAtPositions,
    },
  );
  if (updated === null) return notFound(context);
  return ok(context, {});
};
