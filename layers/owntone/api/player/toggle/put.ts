// layers/owntone/api/player/toggle/put.ts — PUT /api/player/toggle.
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.player.toggle();
  return noContent();
};
