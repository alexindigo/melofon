import { notFound, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import { requireSharing, shareForbidden } from '#opensubsonic/shares.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const denied = await requireSharing(context);
  if (denied) return denied;
  const deleted = await context.app.shares.delete(
    context.state.user!.username,
    id,
  );
  if (deleted === 'forbidden') return shareForbidden(context);
  return deleted ? ok(context, {}) : notFound(context);
};
