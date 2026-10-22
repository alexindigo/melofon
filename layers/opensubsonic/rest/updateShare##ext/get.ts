import { fail, notFound, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import {
  requireSharing,
  shareForbidden,
  shareOptions,
} from '#opensubsonic/shares.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const denied = await requireSharing(context);
  if (denied) return denied;
  const options = shareOptions(context);
  if (options instanceof Response) return options;
  const row = await context.app.shares.update(
    context.state.user!.username,
    id,
    options,
  );
  if (row === 'forbidden') return shareForbidden(context);
  if (row === null) return notFound(context);
  if ('invalid' in row) return fail(context, 0, row.invalid);
  return ok(context, {});
};
