// layers/opensubsonic/rest/getAlbumInfo2/get.ts — GET /rest/getAlbumInfo2
// (see getSimilarSongs).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { albumInfo: {} });
