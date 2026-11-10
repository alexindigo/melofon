import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
import { playerId } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  fields(context, []);
  await core(() => context.app.players.setDefault(playerId(request.params.id)));
  return new Response(null, { status: 204 });
}
