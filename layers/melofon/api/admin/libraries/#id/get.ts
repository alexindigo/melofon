import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fail } from '#melofon/errors.ts';
export default async function (request: HatRequest, context: HatContext) {
  const library = (await context.app.libraries.list()).find((row) =>
    row.id === request.params.id
  );
  if (!library) fail(404, 'not_found', 'Library not found');
  return {
    library: {
      ...library,
      stats: await context.app.libraries.stats(library.id),
    },
  };
}
