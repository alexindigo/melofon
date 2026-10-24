import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
export default async function (_request: HatRequest, context: HatContext) {
  await core(() => context.app.server.clearLog(context.state.user.id));
  return new Response(null, { status: 204 });
}
