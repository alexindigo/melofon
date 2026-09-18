// layers/opensubsonic/rest/getPlayQueue/get.ts — GET /rest/getPlayQueue.
// Navidrome quirk: `current` is a string. Nothing saved → bare ok envelope
// (no playQueue key). username/changedBy are required by the OpenSubsonic
// schema; changedBy is the saving client's name (rows saved before the
// column existed fall back to the username).
import { ok } from '#opensubsonic/envelope.ts';
import { entriesFor } from '#opensubsonic/id3.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const username = context.state.user!.username;
  const queue = await context.app.clientQueue.get(username);
  if (queue === null) return ok(context, {});
  return ok(context, {
    playQueue: {
      entry: await entriesFor(context, queue.trackIds),
      current: queue.currentId ?? undefined,
      position: queue.positionMs ?? undefined,
      username,
      changed: new Date(queue.changedAtMs).toISOString(),
      changedBy: queue.changedBy ?? username,
    },
  });
};
