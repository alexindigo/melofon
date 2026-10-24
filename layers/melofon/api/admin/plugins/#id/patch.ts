import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
export default function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['enabled', 'hosts', 'settings', 'revisions']);
  return core(() =>
    context.app.plugins.change(context.state.user.id, request.params.id, body)
  );
}
