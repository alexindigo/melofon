// layers/opensubsonic/rest/getAlbumInfo/get.ts — GET /rest/getAlbumInfo
// (see getSimilarSongs).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { albumInfo: {} });
