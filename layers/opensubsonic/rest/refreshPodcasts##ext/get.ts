import { ok } from '#opensubsonic/envelope.ts';
import { podcastWriteGuard } from '#opensubsonic/podcasts.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const denied = await podcastWriteGuard(context);
  if (denied) return denied;
  await context.app.podcasts.refresh();
  return ok(context, {});
};
