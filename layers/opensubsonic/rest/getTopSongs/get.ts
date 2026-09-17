// layers/opensubsonic/rest/getTopSongs/get.ts — GET /rest/getTopSongs (see
// getSimilarSongs).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { topSongs: { song: [] } });
