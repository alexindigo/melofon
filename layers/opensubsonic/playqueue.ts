// Shared encoding for both projections of the same core-owned saved queue.
import { entriesFor } from '#opensubsonic/id3.ts';
import type { HatContext, PlayQueueRow } from '#opensubsonic/types.ts';

export function queuePosition(params: URLSearchParams): number {
  const position = Number(params.get('position'));
  return Number.isFinite(position) && position >= 0 ? position : 0;
}

export async function queuePayload(
  context: HatContext,
  username: string,
  queue: PlayQueueRow,
) {
  return {
    entry: await entriesFor(context, queue.trackIds),
    position: queue.positionMs,
    username,
    changed: new Date(queue.changedAtMs).toISOString(),
    changedBy: queue.changedBy ?? username,
  };
}
