import type { HatContext, HatRequest } from '#melofon/types.ts';
import { radioResponse } from '#melofon/radio.ts';

export default function (request: HatRequest, context: HatContext) {
  return radioResponse(request, context, 'song');
}
