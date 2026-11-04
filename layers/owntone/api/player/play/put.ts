// layers/owntone/api/player/play/put.ts — PUT /api/player/play (playback command). On an empty
// queue this is a no-op 204 (state stays stop).
import { playbackCommand, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  return playbackCommand(() => context.app.playback.play(sourceFrom(request)));
};
