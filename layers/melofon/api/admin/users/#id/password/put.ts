import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields, text } from '#melofon/input.ts';
export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['new']);
  await core(() =>
    context.app.users.setPassword(context.state.user.id, request.params.id, {
      new: text(body, 'new'),
    })
  );
  return {};
}
