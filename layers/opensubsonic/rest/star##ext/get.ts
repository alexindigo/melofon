// layers/opensubsonic/rest/star/get.ts — GET /rest/star.
// Targets come from repeated `id`, `albumId` and `artistId` (in that order,
// duplicates kept); core classifies each id as artist, album or song, so an
// old-style `id=<albumId>` stars the album. One core write per id; ids that
// are not in the catalog are skipped and the answer is still ok.
import { fail, ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const targets = [
    ...params.getAll('id'),
    ...params.getAll('albumId'),
    ...params.getAll('artistId'),
  ];
  if (targets.length === 0) {
    return fail(context, 10, 'Required parameter is missing');
  }
  for (const targetId of targets) {
    await context.app.annotation.star(context.state.user!.username, targetId);
  }
  return ok(context, {});
};
