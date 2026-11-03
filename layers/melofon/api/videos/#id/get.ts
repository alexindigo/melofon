import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseLibrary, browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core, fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const folderId = browseLibrary(browseQuery(request, ['library']));
  const snapshot = await core(() =>
    context.app.library.getVideoSnapshot(request.params.id, folderId)
  );
  if (snapshot.detail === null) fail(404, 'not_found', 'Video not found');
  return catalogResponse(
    request,
    snapshot.revision,
    ['video', 1, request.params.id, folderId],
    {
      video: await browseArtwork(context).video(
        snapshot.detail.song,
        snapshot.detail.details,
      ),
    },
  );
}
