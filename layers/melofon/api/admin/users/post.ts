import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields, optionalText, role, text, username } from '#melofon/input.ts';
export default async function (_request: HatRequest, context: HatContext) {
  const body = fields(context, [
    'username',
    'password',
    'role',
    'displayName',
    'email',
  ]);
  const user = await core(() =>
    context.app.users.create(context.state.user.id, {
      username: username(body),
      password: text(body, 'password'),
      role: role(body) ?? 'user',
      displayName: optionalText(body, 'displayName'),
      email: optionalText(body, 'email'),
    })
  );
  return Response.json(user, { status: 201 });
}
