// layers/owntone/api/player/previous/put.ts — PUT /api/player/previous (playback command).
import { playbackCommand, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  return playbackCommand(() =>
    context.app.playback.previous(sourceFrom(request))
  );
};
