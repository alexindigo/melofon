// layers/owntone/api/player/next/put.ts — PUT /api/player/next (playback command). Moves and
// starts playback; past the last item stops.
import { noContent, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  context.app.playback.next(sourceFrom(request));
  return noContent();
};
