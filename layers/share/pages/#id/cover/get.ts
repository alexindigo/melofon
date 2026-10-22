import { load, secured } from '../../../public.ts';
import type { ShareContext, ShareRequest } from '../../../types.ts';

export default async (request: ShareRequest, context: ShareContext) => {
  const share = await load(request, context);
  if (share instanceof Response) return share;
  const first = (await context.app.shares.tracks(share))[0];
  return secured(
    first
      ? await context.app.artwork.cover(first.id, {
        size: Number(request.query.get('size') ?? 0),
      })
      : context.app.artwork.placeholder(),
  );
};
