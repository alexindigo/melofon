// layers/owntone/api/player/shuffle/put.ts — PUT /api/player/shuffle?state=.
import { badRequest, boolParam, noContent } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  const state = request.query.get('state');
  if (state === null) return badRequest();
  context.app.playback.setShuffle(boolParam(state));
  return noContent();
};
