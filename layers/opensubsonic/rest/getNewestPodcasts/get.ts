// layers/opensubsonic/rest/getNewestPodcasts/get.ts — GET
// /rest/getNewestPodcasts (M3 empty-ok stub, see getPodcasts).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { newestPodcasts: { episode: [] } });
