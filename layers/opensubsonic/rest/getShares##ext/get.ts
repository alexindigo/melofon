import { ok } from '#opensubsonic/envelope.ts';
import { requireSharing, shareOf } from '#opensubsonic/shares.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const denied = await requireSharing(context);
  if (denied) return denied;
  const rows = await context.app.shares.list(context.state.user!.username);
  return ok(context, {
    shares: {
      share: await Promise.all(
        rows.map((row) => shareOf(request, context, row)),
      ),
    },
  });
};
