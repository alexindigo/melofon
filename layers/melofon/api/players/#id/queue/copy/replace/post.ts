import type { HatContext, HatRequest } from '#melofon/types.ts';
import { copyQueue } from '#melofon/queue-copy.ts';

export default function (request: HatRequest, context: HatContext) {
  return copyQueue(request, context, 'replace');
}
