import { fail, notFound, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import {
  requireSharing,
  shareForbidden,
  shareOf,
  shareOptions,
} from '#opensubsonic/shares.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const denied = await requireSharing(context);
  if (denied) return denied;
  const options = shareOptions(context);
  if (options instanceof Response) return options;
  const row = await context.app.shares.create(
    context.state.user!.username,
    context.state.params!.getAll('id'),
    options,
  );
  if (row === 'disabled') return shareForbidden(context);
  if (row === null) return notFound(context);
  if ('invalid' in row) return fail(context, 0, row.invalid);
  return ok(context, {
    shares: { share: [await shareOf(request, context, row)] },
  });
};
