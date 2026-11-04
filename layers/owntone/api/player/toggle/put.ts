// layers/owntone/api/player/toggle/put.ts — PUT /api/player/toggle (playback command).
import { playbackCommand, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  return playbackCommand(() =>
    context.app.playback.toggle(sourceFrom(request))
  );
};
