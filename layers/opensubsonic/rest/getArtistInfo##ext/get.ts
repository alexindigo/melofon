import { artistInfo } from '#opensubsonic/reference.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (request: HatRequest, context: HatContext) =>
  artistInfo(request, context, false);
