// layers/opensubsonic/rest/getArtistInfo2/get.ts — GET /rest/getArtistInfo2
// (see getSimilarSongs).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { artistInfo2: {} });
