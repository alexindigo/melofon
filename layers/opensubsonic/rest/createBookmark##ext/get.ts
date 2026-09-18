// layers/opensubsonic/rest/createBookmark/get.ts — GET /rest/createBookmark.
import { fail, ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const params = context.state.params!;
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  const rawPosition = params.get('position');
  const position = rawPosition === null ? NaN : Number(rawPosition);
  if (!Number.isFinite(position) || position < 0) {
    return fail(
      context,
      10,
      'position must be a non-negative number',
    );
  }
  await context.app.bookmarks.set(
    context.state.user!.username,
    id,
    position,
    params.get('comment') ?? undefined,
  );
  return ok(context, {});
};
