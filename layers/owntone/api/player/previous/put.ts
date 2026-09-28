// layers/owntone/api/player/previous/put.ts — PUT /api/player/previous (playback command).
import { noContent, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  context.app.playback.previous(sourceFrom(request));
  return noContent();
};
