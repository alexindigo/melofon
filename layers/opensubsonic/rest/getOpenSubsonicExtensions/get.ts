// layers/opensubsonic/rest/getOpenSubsonicExtensions/get.ts — GET
// /rest/getOpenSubsonicExtensions: no extensions advertised.
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { openSubsonicExtensions: { openSubsonicExtension: [] } });
