// layers/owntone/api/player/pause/put.ts — PUT /api/player/pause (playback command).
import { noContent, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  context.app.playback.pause(sourceFrom(request));
  return noContent();
};
