import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseLibrary, browseQuery } from '#melofon/browse.ts';
import { artistReference, browseArtwork } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';
import { core, fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const folderId = browseLibrary(browseQuery(request, ['library']));
  const { artist, revision } = await core(() =>
    context.app.library.getArtistSnapshot(
      artistReference(request.params.id),
      folderId,
    )
  );
  if (artist === null) fail(404, 'not_found', 'Artist not found');
  return catalogResponse(request, revision, [
    'artist',
    1,
    request.params.id,
    folderId ?? null,
  ], { artist: await browseArtwork(context).artist(artist) });
}
