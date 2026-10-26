import type { HatContext } from './types.ts';

export async function savedQueue(context: HatContext) {
  const queue = await context.app.clientQueue.get(context.state.user.username);
  return {
    queue: queue === null ? null : {
      songIds: queue.trackIds,
      currentIndex: queue.currentIndex,
      positionMs: queue.positionMs,
      changedAt: new Date(queue.changedAtMs).toISOString(),
      changedBy: queue.changedBy,
    },
  };
}
