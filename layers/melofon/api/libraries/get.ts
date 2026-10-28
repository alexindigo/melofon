import type { HatContext, HatRequest } from '#melofon/types.ts';
import { browseQuery } from '#melofon/browse.ts';
import { librarySummary } from '#melofon/browse-payloads.ts';

export default async function (request: HatRequest, context: HatContext) {
  browseQuery(request);
  return {
    libraries: (await context.app.libraries.list()).map(librarySummary),
  };
}
