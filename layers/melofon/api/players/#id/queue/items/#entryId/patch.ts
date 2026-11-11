import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { fields } from '#melofon/input.ts';
import { source } from '#melofon/libraries.ts';
import { playerId } from '#melofon/players.ts';
import { entryId, expectedVersion } from '#melofon/queue-edit.ts';

export default async function (request: HatRequest, context: HatContext) {
  const body = fields(context, ['position', 'expectedVersion']);
  if (!Number.isSafeInteger(body.position) || Number(body.position) < 0) {
    fail(400, 'invalid_field', 'position must be a nonnegative integer');
  }
  const version = expectedVersion(body.expectedVersion);
  const entry = entryId(request.params.entryId);
  await core(async () => {
    await context.app.players.get(playerId(request.params.id)).queueMove(
      entry,
      Number(body.position),
      version,
      source(request, context),
    );
  });
  return new Response(null, { status: 204 });
}
