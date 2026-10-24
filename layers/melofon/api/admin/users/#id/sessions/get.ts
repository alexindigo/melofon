import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { sessionList } from '#melofon/payloads.ts';
export default async function (request: HatRequest, context: HatContext) {
  await core(() =>
    context.app.users.get(context.state.user.id, request.params.id)
  );
  return sessionList(
    await core(() =>
      context.app.sessions.list(context.state.user.id, request.params.id)
    ),
    context.state.sessionId,
  );
}
