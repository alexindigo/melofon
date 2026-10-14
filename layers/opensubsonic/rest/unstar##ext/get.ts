// layers/opensubsonic/rest/unstar/get.ts — GET /rest/unstar (see star). An
// item that has left the catalog can still be unstarred.
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
    await context.app.annotation.unstar(
      context.state.user!.username,
      targetId,
    );
  }
  return ok(context, {});
};
