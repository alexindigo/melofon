import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseLibrary, browseQuery } from '#melofon/browse.ts';
import { browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core, fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const folderId = browseLibrary(browseQuery(request, ['library']));
  const { detail, revision } = await core(() =>
    context.app.library.getAlbumSnapshot(request.params.id, folderId)
  );
  if (detail === null) fail(404, 'not_found', 'Album not found');
  const payload = browseArtwork(context);
  return catalogResponse(request, revision, [
    'album',
    1,
    request.params.id,
    folderId ?? null,
  ], {
    album: {
      ...await payload.album(detail.album),
      songs: await Promise.all(detail.songs.map(payload.song)),
    },
  });
}
