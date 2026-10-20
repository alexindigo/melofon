// layers/opensubsonic/rest/savePlayQueue/get.ts — GET /rest/savePlayQueue.
import { ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { queuePosition } from '#opensubsonic/playqueue.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const trackIds = params.getAll('id');
  let currentIndex = 0;
  if (trackIds.length !== 0) {
    const current = requiredParam(context, 'current');
    if (current instanceof Response) return current;
    currentIndex = Math.max(0, trackIds.indexOf(current));
  }
  await context.app.clientQueue.save(context.state.user!.username, {
    trackIds,
    currentIndex,
    positionMs: queuePosition(params),
    changedBy: params.get('c') ?? undefined,
  });
  return ok(context, {});
};
