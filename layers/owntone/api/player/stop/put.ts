// layers/owntone/api/player/stop/put.ts — PUT /api/player/stop (playback command).
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.playback.stop();
  return noContent();
};
