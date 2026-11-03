import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request);
  const { song, revision } = await context.app.library.getSongSnapshot(
    request.params.id,
  );
  if (song === null) fail(404, 'not_found', 'Song not found');
  return catalogResponse(request, revision, ['song', 1, song.id], {
    song: await browseArtwork(context).song(song),
  });
}
