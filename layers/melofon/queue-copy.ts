import type { HatContext, HatRequest } from './types.ts';
import { core, fail } from './errors.ts';
import { fields } from './input.ts';
import { source } from './libraries.ts';
import { playerId } from './players.ts';
import { expectedVersion, queueDestination } from './queue-edit.ts';

export async function copyQueue(
  request: HatRequest,
  context: HatContext,
  mode: 'replace' | 'add',
) {
  const body = fields(
    context,
    mode === 'add'
      ? ['targetPlayerId', 'where', 'startPlaying', 'expectedVersion']
      : ['targetPlayerId', 'startPlaying', 'expectedVersion'],
  );
  if (
    !Number.isSafeInteger(body.targetPlayerId) ||
    Number(body.targetPlayerId) < 1
  ) {
    fail(400, 'invalid_field', 'targetPlayerId must be a positive integer');
  }
  if (
    body.startPlaying !== undefined && typeof body.startPlaying !== 'boolean'
  ) {
    fail(400, 'invalid_field', 'startPlaying must be a boolean');
  }
  const options = {
    mode,
    where: queueDestination(body.where),
    startPlaying: body.startPlaying as boolean | undefined,
    expectedVersion: expectedVersion(body.expectedVersion),
  };
  await core(() =>
    context.app.players.copyQueue(
      playerId(request.params.id),
      Number(body.targetPlayerId),
      options,
      source(request, context),
    )
  );
  return new Response(null, { status: 204 });
}
