// layers/owntone/api/queue/clear/put.ts — PUT /api/queue/clear (also stops
// playback, like OwnTone's clear path).
import { noContent } from '#owntone/payloads.ts';
import type { HatContext } from '#owntone/types.ts';

export default (_request: unknown, context: HatContext) => {
  context.app.playback.queueClear();
  return noContent();
};
