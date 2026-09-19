// layers/owntone/api/player/previous/put.ts — PUT /api/player/previous (playback command).
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.playback.previous();
  return noContent();
};
