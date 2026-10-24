import type { SetupContext, SetupRequest } from '../types.ts';
import { core, fail } from '../errors.ts';

export default async function (request: SetupRequest, context: SetupContext) {
  const body = context.state.json;
  if (
    Object.keys(body).some((key) =>
      !['code', 'username', 'password', 'displayName'].includes(key)
    )
  ) fail(400, 'invalid_field', 'Unknown field');
  const text = (key: string): string => {
    if (typeof body[key] !== 'string') {
      fail(400, 'invalid_field', `${key} must be a string`);
    }
    return body[key];
  };
  const input = {
    code: text('code'),
    username: text('username'),
    password: text('password'),
    ...(body.displayName === undefined
      ? {}
      : { displayName: text('displayName') }),
  };
  if (!input.username.trim()) {
    fail(400, 'invalid_field', 'username must not be empty');
  }
  // Production Deno.serve supplies this wire-completion promise. Fail closed
  // before creating an admin if a host doesn't provide the lifecycle contract.
  if (!request.completed) {
    throw new Error('Response completion is required for setup');
  }
  const user = await core(() =>
    context.app.setup.create(
      input,
      request.remoteAddr?.hostname ?? '',
      request.completed!,
    )
  );
  return Response.json({ user, restarting: true }, { status: 201 });
}
