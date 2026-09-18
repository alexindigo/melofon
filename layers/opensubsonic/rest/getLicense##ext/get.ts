// layers/opensubsonic/rest/getLicense/get.ts — GET /rest/getLicense.
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, { license: { valid: true } });
