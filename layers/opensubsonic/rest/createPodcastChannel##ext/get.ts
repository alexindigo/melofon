import { fail, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { podcastWriteGuard } from '#opensubsonic/podcasts.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const url = requiredParam(context, 'url');
  if (url instanceof Response) return url;
  const denied = await podcastWriteGuard(context);
  if (denied) return denied;
  try {
    // Core keeps feed failures as channel status=error; that is still success.
    await context.app.podcasts.addChannel(url);
    return ok(context, {});
  } catch (error) {
    return fail(
      context,
      0,
      error instanceof Error ? error.message : String(error),
    );
  }
};
