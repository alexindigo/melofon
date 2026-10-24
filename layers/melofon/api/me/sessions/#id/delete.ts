import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { cookie } from '#melofon/payloads.ts';
export default async function (request: HatRequest, context: HatContext) {
  await core(() =>
    context.app.sessions.revoke(context.state.user.id, request.params.id)
  );
  return Response.json({}, {
    headers: request.params.id === context.state.sessionId
      ? { 'Set-Cookie': await cookie(request, context) }
      : {},
  });
}
