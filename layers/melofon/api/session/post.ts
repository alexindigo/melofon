import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields, optionalText, text, username } from '#melofon/input.ts';
import { cookie, me } from '#melofon/payloads.ts';
import { fail } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['username', 'password', 'deviceName', 'use']);
  const use = body.use === undefined ? 'cookie' : body.use;
  if (use !== 'cookie' && use !== 'bearer') {
    fail(400, 'invalid_field', 'use must be cookie or bearer');
  }
  // Deno.serve info -> facade(app(request, info)) -> PathfinderRequest.remoteAddr.
  // A missing transport identity is a server wiring failure, never a forwarded header.
  if (!request.remoteAddr) throw new Error('Missing client address');
  const result = await core(() =>
    context.app.signIn({
      username: username(body),
      password: text(body, 'password'),
      clientAddress: request.remoteAddr!.hostname,
      deviceName: optionalText(body, 'deviceName') ?? '',
      userAgent: request.headers.get('user-agent') ?? '',
    })
  );
  const user = await core(() =>
    context.app.users.get(result.session.userId, result.session.userId)
  );
  const payload = {
    session: {
      id: result.session.id,
      deviceName: result.session.deviceName,
      createdAt: result.session.createdAt,
    },
    user: me(user, result.session),
    ...(use === 'bearer' ? { key: result.key } : {}),
  };
  return Response.json(payload, {
    headers: use === 'cookie'
      ? { 'Set-Cookie': await cookie(request, context, result.key) }
      : {},
  });
}
