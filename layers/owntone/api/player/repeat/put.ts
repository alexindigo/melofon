// layers/owntone/api/player/repeat/put.ts — PUT /api/player/repeat?state=
// (off|all|single; anything else → 400 like OwnTone).
import { badRequest, noContent } from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  const state = request.query.get('state');
  if (state !== 'off' && state !== 'all' && state !== 'single') {
    return badRequest();
  }
  context.app.playback.setRepeat(state);
  return noContent();
};
