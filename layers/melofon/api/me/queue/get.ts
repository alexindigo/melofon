import type { HatContext, HatRequest } from '#melofon/types.ts';
import { savedQueue } from '#melofon/queue.ts';

export default function (_request: HatRequest, context: HatContext) {
  return savedQueue(context);
}
