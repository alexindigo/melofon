import { requiredParam } from '#opensubsonic/params.ts';
import { stationResult, stationWriteGuard } from '#opensubsonic/radio.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const denied = await stationWriteGuard(context);
  if (denied) return denied;
  return stationResult(
    context,
    await context.app.radio.delete(id),
  );
};
