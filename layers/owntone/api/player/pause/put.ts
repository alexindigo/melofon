// layers/owntone/api/player/pause/put.ts — PUT /api/player/pause (playback command).
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.playback.pause();
  return noContent();
};
