import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fields, nullableText } from '#melofon/input.ts';
import { core } from '#melofon/errors.ts';
import { current } from '#melofon/payloads.ts';
export default async function (_request: HatRequest, context: HatContext) {
  const body = fields(context, ['displayName', 'email']);
  context.state.user = await core(() =>
    context.app.users.update(context.state.user.id, context.state.user.id, {
      displayName: nullableText(body, 'displayName'),
      email: nullableText(body, 'email'),
    })
  );
  return current(context);
}
