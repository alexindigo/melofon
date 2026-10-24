import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core, fail } from '#melofon/errors.ts';
import { source } from '#melofon/libraries.ts';
export default async function (request: HatRequest, context: HatContext) {
  const removed = await core(() =>
    context.app.libraries.remove(request.params.id, source(request, context))
  );
  if (!removed) fail(404, 'not_found', 'Library not found');
  return new Response(null, { status: 204 });
}
