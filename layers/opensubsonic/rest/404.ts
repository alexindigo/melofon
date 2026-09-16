// 404 under /rest/ — Subsonic envelope, not pathfinder JSON. The miss chain
// runs 10-auth first, so unauthenticated misses fail as 40/10 before this
// page renders.
import {
  failResponse,
  type HatContext,
  type HatRequest,
  params,
} from '../00-subsonic.ts';

export default async (request: HatRequest, context: HatContext) => {
  context.state.params ??= await params(request);
  return failResponse(context, 0, 'Not found', 404);
};
