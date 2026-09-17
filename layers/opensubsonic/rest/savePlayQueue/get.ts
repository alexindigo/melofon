// layers/opensubsonic/rest/savePlayQueue/get.ts — GET /rest/savePlayQueue.
import { ok } from '#opensubsonic/envelope.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const rawPosition = params.get('position');
  const position = rawPosition === null ? NaN : Number(rawPosition);
  await context.app.clientQueue.save(context.state.user!.username, {
    trackIds: params.getAll('id'),
    currentId: params.get('current') ?? undefined,
    positionMs: Number.isFinite(position) && position >= 0
      ? position
      : undefined,
    changedBy: params.get('c') ?? undefined,
  });
  return ok(context, {});
};
