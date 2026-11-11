import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';
import { playerId } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  const { linked } = fields(context, ['linked']);
  if (typeof linked !== 'boolean') {
    fail(400, 'invalid_field', 'linked must be a boolean');
  }
  await core(() =>
    context.app.players.setLinked(
      playerId(request.params.id),
      request.params.speakerId,
      linked,
      source(request, context),
    )
  );
  return new Response(null, { status: 204 });
}
