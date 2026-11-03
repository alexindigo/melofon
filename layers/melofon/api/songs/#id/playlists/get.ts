import type { HatContext, HatRequest } from '#melofon/types.ts';
import { playlistPageQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const query = await playlistPageQuery(request, context);
  const page = await context.app.playlists.containingSong(
    context.state.user.username,
    request.params.id,
    query,
  );
  if (page === null) fail(404, 'not_found', 'Song not found');
  return Response.json({
    playlists: await Promise.all(
      page.rows.map(browseArtwork(context).playlist),
    ),
    total: page.total,
    offset: query.offset,
    limit: query.limit,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
