import type { HatContext, HatRequest } from '#melofon/types.ts';
import auth from '#melofon/auth.ts';
import { core } from '#melofon/errors.ts';
import { cookie } from '#melofon/payloads.ts';

export default async function (request: HatRequest, context: HatContext) {
  // This folder alone mixes public POST and protected DELETE.
  await auth(request, context);
  await core(() =>
    context.app.sessions.revoke(context.state.user.id, context.state.sessionId)
  );
  return Response.json({}, {
    headers: { 'Set-Cookie': await cookie(request, context) },
  });
}
