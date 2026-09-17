// layers/opensubsonic/rest/getSimilarSongs/get.ts — GET
// /rest/getSimilarSongs. No Last.fm, no recommendations (plan: do not add a
// network agent).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { similarSongs: { song: [] } });
