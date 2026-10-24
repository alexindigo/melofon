import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { sessionList } from '#melofon/payloads.ts';
export default async function (_request: HatRequest, context: HatContext) {
  return sessionList(
    await core(() => context.app.sessions.list(context.state.user.id)),
    context.state.sessionId,
  );
}
