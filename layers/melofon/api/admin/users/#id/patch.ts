import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields, nullableText, role, username } from '#melofon/input.ts';
export default function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['username', 'displayName', 'email', 'role']);
  return core(() =>
    context.app.users.update(context.state.user.id, request.params.id, {
      username: body.username === undefined ? undefined : username(body),
      displayName: nullableText(body, 'displayName'),
      email: nullableText(body, 'email'),
      role: role(body),
    })
  );
}
