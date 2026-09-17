// layers/opensubsonic/rest/ping/get.ts — GET /rest/ping.
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) => ok(context, {});
