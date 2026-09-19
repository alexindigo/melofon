// layers/owntone/api/player/play/put.ts — PUT /api/player/play (playback command). On an empty
// queue this is a no-op 204 (state stays stop).
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.playback.play();
  return noContent();
};
