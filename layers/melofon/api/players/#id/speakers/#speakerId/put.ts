import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';
import { playerId } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  fields(context, []);
  await core(() =>
    context.app.players.join(
      playerId(request.params.id),
      request.params.speakerId,
      source(request, context),
    )
  );
  return new Response(null, { status: 204 });
}
