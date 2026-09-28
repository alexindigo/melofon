// layers/owntone/api/queue/clear/put.ts — PUT /api/queue/clear (also stops
// playback, like OwnTone's clear path).
import { noContent, sourceFrom } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  context.app.playback.queueClear(sourceFrom(request));
  return noContent();
};
