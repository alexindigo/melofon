// layers/opensubsonic/rest/getPlayQueue/get.ts — GET /rest/getPlayQueue.
// `current` is a string. Nothing saved → bare ok envelope
// (no playQueue key). username/changedBy are required by the OpenSubsonic
// schema; changedBy is the saving client's name (rows saved before the
// column existed fall back to the username).
import { ok } from '#opensubsonic/envelope.ts';
import { queuePayload } from '#opensubsonic/playqueue.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const username = context.state.user!.username;
  const queue = await context.app.clientQueue.get(username);
  if (queue === null) return ok(context, {});
  return ok(context, {
    playQueue: {
      ...await queuePayload(context, username, queue),
      current: queue.trackIds[queue.currentIndex],
    },
  });
};
