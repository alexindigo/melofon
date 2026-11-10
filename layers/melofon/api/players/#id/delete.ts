import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { playerId } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  await core(() => context.app.players.delete(playerId(request.params.id)));
  return new Response(null, { status: 204 });
}
