// layers/owntone/api/player/volume/put.ts — PUT /api/player/volume:
// ?volume= absolute (wins) or ?step  = relative; ?output_id= targets one
// output instead of the master. Missing both volume and step → 400.
import {
  badRequest,
  intParam,
  noContent,
  sourceFrom,
} from '#owntone/payloads.ts';
import type { HatContext, HatRequest } from '#owntone/types.ts';

export default (request: HatRequest, context: HatContext) => {
  const volume = intParam(request.query.get('volume'));
  const step = intParam(request.query.get('step'));
  const outputId = request.query.get('output_id');
  if (outputId !== null) {
    const output = context.app.outputs.get(outputId);
    if (output === null || (volume === null && step === null)) {
      return badRequest();
    }
    context.app.outputs.update(outputId, {
      volume: volume ?? output.volume + (step ?? 0),
    }, sourceFrom(request));
    return noContent();
  }
  if (volume !== null) {
    context.app.playback.setVolume({ volume }, sourceFrom(request));
    return noContent();
  }
  if (step !== null) {
    context.app.playback.setVolume({ step }, sourceFrom(request));
    return noContent();
  }
  return badRequest();
};
