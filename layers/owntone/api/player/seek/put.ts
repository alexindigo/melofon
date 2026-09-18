// layers/owntone/api/player/seek/put.ts — PUT /api/player/seek:
// ?position_ms= absolute or ?seek_ms= relative. OwnTone starts playback
// after a seek; an empty queue → 500 like theirs.
import {
  badRequest,
  internalError,
  intParam,
  noContent,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  const positionMs = intParam(request.query.get('position_ms'));
  if (positionMs !== null) {
    return context.app.player.seek({ positionMs })
      ? noContent()
      : internalError();
  }
  const seekMs = intParam(request.query.get('seek_ms'));
  if (seekMs !== null) {
    return context.app.player.seek({ seekMs }) ? noContent() : internalError();
  }
  return badRequest();
};
