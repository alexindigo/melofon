// layers/owntone/api/player/stop/put.ts — PUT /api/player/stop.
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.player.stop();
  return noContent();
};
