import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { playerId, playerPayload } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  const id = playerId(request.params.id);
  const player = await core(() => Promise.resolve(playerPayload(context, id)));
  return Response.json({ player }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
