// layers/owntone/api/player/previous/put.ts — PUT /api/player/previous.
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.player.previous();
  return noContent();
};
