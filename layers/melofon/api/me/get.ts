import type { HatContext, HatRequest } from '#melofon/types.ts';
import { current } from '#melofon/payloads.ts';
export default function (_request: HatRequest, context: HatContext) {
  return current(context);
}
