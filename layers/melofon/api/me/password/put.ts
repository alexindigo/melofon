import type { HatContext, HatRequest } from '#melofon/types.ts';
import { fields, text } from '#melofon/input.ts';
import { core } from '#melofon/errors.ts';
import { cookie } from '#melofon/payloads.ts';
export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['current', 'new']);
  await core(() =>
    context.app.users.setPassword(
      context.state.user.id,
      context.state.user.id,
      {
        current: text(body, 'current'),
        new: text(body, 'new'),
      },
    )
  );
  return Response.json({}, {
    headers: { 'Set-Cookie': await cookie(request, context) },
  });
}
