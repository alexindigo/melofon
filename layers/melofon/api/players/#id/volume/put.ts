import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { volume } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';
import { playerId } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  const value = volume(context);
  await core(() =>
    context.app.players.get(playerId(request.params.id)).setVolume(
      { volume: value },
      source(request, context),
    )
  );
  return new Response(null, { status: 204 });
}
