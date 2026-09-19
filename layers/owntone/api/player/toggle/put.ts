// layers/owntone/api/player/toggle/put.ts — PUT /api/player/toggle (playback command).
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.playback.toggle();
  return noContent();
};
