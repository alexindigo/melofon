import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fail } from '#melofon/errors.ts';
export default function (_request: HatRequest, context: HatContext) {
  if (context.state.user.role !== 'admin') fail(403, 'forbidden', 'Forbidden');
}
