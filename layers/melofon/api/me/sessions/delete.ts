import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { cookie } from '#melofon/payloads.ts';
export default async function (request: HatRequest, context: HatContext) {
  await core(() => context.app.sessions.revokeAll(context.state.user.id));
  return Response.json({}, {
    headers: { 'Set-Cookie': await cookie(request, context) },
  });
}
