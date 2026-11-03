import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request, []);
  const row = await context.app.playlists.get(
    context.state.user.username,
    request.params.id,
  );
  if (!row) fail(404, 'not_found', 'Playlist not found');
  return Response.json({
    playlist: {
      ...await browseArtwork(context).playlist(row),
      trackIds: row.trackIds,
    },
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
