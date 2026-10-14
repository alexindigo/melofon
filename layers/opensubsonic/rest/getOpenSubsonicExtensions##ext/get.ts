// Public server-wide capabilities, shared by the GET and POST routes.
import { capabilityPayload } from '#opensubsonic/capabilities.ts';
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default (_request: HatRequest, context: HatContext) =>
  ok(context, capabilityPayload());
