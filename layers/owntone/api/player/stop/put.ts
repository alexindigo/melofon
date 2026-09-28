// layers/owntone/api/player/stop/put.ts — PUT /api/player/stop (playback command).
import { noContent, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  context.app.playback.stop(sourceFrom(request));
  return noContent();
};
