import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
export default function (_request: HatRequest, context: HatContext) {
  fields(context, []);
  return core(() => context.app.hats.rescan(context.state.user.id));
}
