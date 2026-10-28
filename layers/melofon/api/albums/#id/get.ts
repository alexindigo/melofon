import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseLibrary, browseQuery } from '#melofon/browse.ts';
import { albumSummary, songDetail } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core, fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const folderId = browseLibrary(browseQuery(request, ['library']));
  const { detail, revision } = await core(() =>
    context.app.library.getAlbumSnapshot(request.params.id, folderId)
  );
  if (detail === null) fail(404, 'not_found', 'Album not found');
  return catalogResponse(request, revision, [
    'album',
    1,
    request.params.id,
    folderId ?? null,
  ], {
    album: {
      ...albumSummary(detail.album),
      songs: detail.songs.map(songDetail),
    },
  });
}
