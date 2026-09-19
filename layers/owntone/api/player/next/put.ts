// layers/owntone/api/player/next/put.ts — PUT /api/player/next (playback command). Moves and
// starts playback; past the last item stops.
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.playback.next();
  return noContent();
};
