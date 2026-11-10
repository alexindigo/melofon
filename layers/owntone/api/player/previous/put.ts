// layers/owntone/api/player/previous/put.ts — PUT /api/player/previous (playback command).
import { playbackCommand, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  const playback = context.app.playback;
  return playbackCommand(() => {
    const source = sourceFrom(request);
    return playback.playerView().itemProgressMs > 3000
      ? playback.restart(source)
      : playback.previous(source);
  });
};
