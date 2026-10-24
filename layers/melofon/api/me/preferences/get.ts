import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';

export default function (_request: HatRequest, context: HatContext) {
  return core(() => context.app.preferences.get(context.state.user.id));
}
