// layers/opensubsonic/rest/getArtistInfo/get.ts — GET /rest/getArtistInfo
// (see getSimilarSongs).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { artistInfo: {} });
