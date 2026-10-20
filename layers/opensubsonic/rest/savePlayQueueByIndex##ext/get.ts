import { fail, ok } from '#opensubsonic/envelope.ts';
import { integerParam } from '#opensubsonic/params.ts';
import { queuePosition } from '#opensubsonic/playqueue.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const trackIds = params.getAll('id');
  const rawIndex = params.get('currentIndex');
  const currentIndex = integerParam(rawIndex);
  if (
    trackIds.length === 0
      ? rawIndex !== null
      : rawIndex === null || rawIndex.trim() === '' || currentIndex === null ||
        currentIndex < 0 || currentIndex >= trackIds.length
  ) {
    return fail(
      context,
      10,
      'currentIndex must identify an entry in the queue',
    );
  }
  await context.app.clientQueue.save(context.state.user!.username, {
    trackIds,
    currentIndex: currentIndex ?? 0,
    positionMs: queuePosition(params),
    changedBy: params.get('c') ?? undefined,
  });
  return ok(context, {});
};
