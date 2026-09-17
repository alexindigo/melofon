// layers/opensubsonic/rest/deleteBookmark/get.ts — GET /rest/deleteBookmark.
// Unknown ids are ok, not 404: delete is idempotent (don't-die).
import { ok } from '#opensubsonic/envelope.ts';
import { requiredParam } from '#opensubsonic/params.ts';
import type { HatContext, HatRequest } from '#opensubsonic/types.ts';

export default async (_request: HatRequest, context: HatContext) => {
  const id = requiredParam(context, 'id');
  if (id instanceof Response) return id;
  await context.app.bookmarks.remove(context.state.user!.username, id);
  return ok(context, {});
};
