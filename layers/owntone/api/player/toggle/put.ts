// layers/owntone/api/player/toggle/put.ts — PUT /api/player/toggle (playback command).
import { noContent, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  context.app.playback.toggle(sourceFrom(request));
  return noContent();
};
