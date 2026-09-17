// 404 under /rest/ — Subsonic envelope, not pathfinder JSON. The miss chain
// runs 10-auth first, so unauthenticated misses fail as 40/10 before this
// page renders. Spec ops with no file yet land here too (no "Not
// implemented" catch-all).
import { fail } from '#opensubsonic/envelope.ts';
import { params } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  context.state.params ??= await params(request);
  return fail(context, 0, 'Not found', 404);
};
