import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields, text } from '#melofon/input.ts';
import { playerId, playerPayload } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  const id = playerId(request.params.id);
  const name = text(fields(context, ['name']), 'name');
  const player = await core(async () => {
    await context.app.players.rename(id, name);
    return playerPayload(context, id);
  });
  return Response.json({ player }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
