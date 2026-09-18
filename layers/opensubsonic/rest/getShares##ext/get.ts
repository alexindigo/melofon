// layers/opensubsonic/rest/getShares/get.ts — GET /rest/getShares (M3
// empty-ok stub, see getPodcasts).
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { shares: { share: [] } });
