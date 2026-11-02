import type { HatContext, HatRequest } from './types.ts';
import { browseInteger, browseLibrary, browseQuery } from './browse.ts';
import { artistReference } from './browse-payloads.ts';
import { core, fail } from './errors.ts';

export async function artistReferenceQuery(
  request: HatRequest,
  context: HatContext,
  info = false,
) {
  const params = browseQuery(request, [
    'library',
    'limit',
    ...(info ? ['includeNotPresent'] : []),
  ]);
  const folderId = browseLibrary(params);
  const max = Number(
    await context.app.state.getTyped('melofon.browseMaxPageRecords'),
  );
  const fallback = Math.min(
    max,
    Number(await context.app.state.getTyped('melofon.browsePageRecords')),
  );
  const limit = browseInteger(params, 'limit', fallback, 1, max);
  const include = params.get('includeNotPresent');
  if (include !== null && include !== 'true' && include !== 'false') {
    fail(400, 'invalid_field', 'Invalid includeNotPresent');
  }
  const { artist } = await core(() =>
    context.app.library.getArtistSnapshot(
      artistReference(request.params.id),
      folderId,
    )
  );
  if (artist === null) fail(404, 'not_found', 'Artist not found');
  return { artist, folderId, limit, includeNotPresent: include === 'true' };
}
