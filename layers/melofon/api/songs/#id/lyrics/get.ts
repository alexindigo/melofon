import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery, requireSong } from '#melofon/browse.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request);
  await requireSong(context, request.params.id);
  const lyrics = await context.app.library.lyricsBySongId(request.params.id);
  // Local sources are read live, independently of the indexed catalog revision.
  return Response.json({ lyrics }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
