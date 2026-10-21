import { notFound, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { podcastWriteGuard } from '#opensubsonic/podcasts.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const denied = await podcastWriteGuard(context);
  if (denied) return denied;
  return await context.app.podcasts.deleteChannel(id)
    ? ok(context, {})
    : notFound(context);
};
