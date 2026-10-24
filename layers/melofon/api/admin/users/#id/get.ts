import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
export default function (request: HatRequest, context: HatContext) {
  return core(() =>
    context.app.users.get(context.state.user.id, request.params.id)
  );
}
