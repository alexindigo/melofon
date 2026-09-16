// 500 under /rest/ — Subsonic envelope; internals stay in the server log
// (pathfinder console.error), the client gets a generic failure.
import {
  failResponse,
  type HatContext,
  type HatRequest,
  params,
} from '../00-subsonic.ts';

export default async (request: HatRequest, context: HatContext) => {
  context.state.params ??= await params(request);
  return failResponse(context, 0, 'Internal server error', 500);
};
