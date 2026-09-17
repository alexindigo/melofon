// 500 under /rest/ — Subsonic envelope; internals stay in the server log
// (pathfinder console.error), the client gets a generic failure.
import { fail } from '#opensubsonic/envelope.ts';
import { params } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  context.state.params ??= await params(request);
  return fail(context, 0, 'Internal server error', 500);
};
