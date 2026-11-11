import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { source } from '#melofon/libraries.ts';
import { playerId } from '#melofon/players.ts';
import { deleteVersion, entryId } from '#melofon/queue-edit.ts';

export default async function (request: HatRequest, context: HatContext) {
  const version = deleteVersion(request);
  const entry = entryId(request.params.entryId);
  await core(async () => {
    await context.app.players.get(playerId(request.params.id)).queueRemove(
      entry,
      version,
      source(request, context),
    );
  });
  return new Response(null, { status: 204 });
}
