import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request, []);
  const rows = await context.app.playlists.visible(context.state.user.username);
  if (!Array.isArray(rows)) fail(404, 'not_found', 'Playlists not found');
  return Response.json({
    playlists: await Promise.all(rows.map(browseArtwork(context).playlist)),
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
