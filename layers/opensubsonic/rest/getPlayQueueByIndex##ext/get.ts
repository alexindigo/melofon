import { ok } from '#opensubsonic/envelope.ts';
import { queuePayload } from '#opensubsonic/playqueue.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const username = context.state.user!.username;
  const queue = await context.app.clientQueue.get(username);
  if (queue === null) return ok(context, {});
  return ok(context, {
    playQueueByIndex: {
      ...await queuePayload(context, username, queue),
      currentIndex: queue.currentIndex,
    },
  });
};
