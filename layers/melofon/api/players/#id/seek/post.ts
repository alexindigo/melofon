import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';
import { playerId } from '#melofon/players.ts';

export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['positionMs', 'seekMs']);
  const { positionMs, seekMs } = body;
  if ((positionMs === undefined) === (seekMs === undefined)) {
    fail(400, 'invalid_field', 'Provide exactly one of positionMs or seekMs');
  }
  if (
    positionMs !== undefined &&
    (typeof positionMs !== 'number' || !Number.isSafeInteger(positionMs) ||
      positionMs < 0)
  ) fail(400, 'invalid_field', 'positionMs must be a nonnegative integer');
  if (
    seekMs !== undefined &&
    (typeof seekMs !== 'number' || !Number.isSafeInteger(seekMs))
  ) fail(400, 'invalid_field', 'seekMs must be an integer');
  await core(async () => {
    await context.app.players.get(playerId(request.params.id)).seek(
      { positionMs, seekMs },
      source(request, context),
    );
  });
  return new Response(null, { status: 204 });
}
