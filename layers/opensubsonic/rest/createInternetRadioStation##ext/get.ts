import {
  stationInput,
  stationResult,
  stationWriteGuard,
} from '#opensubsonic/radio.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const input = stationInput(context);
  if (input instanceof Response) return input;
  const denied = await stationWriteGuard(context);
  if (denied) return denied;
  return stationResult(
    context,
    await context.app.radio.create(input),
  );
};
