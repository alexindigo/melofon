import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { librarySummary } from '#melofon/browse-payloads.ts';
import { catalogResponse } from '#melofon/cache.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request);
  const snapshot = await context.app.libraries.snapshot();
  return catalogResponse(request, snapshot.revision, ['libraries', 1], {
    libraries: snapshot.libraries.map(librarySummary),
  });
}
