import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';
import { source } from '#melofon/libraries.ts';

export default async function (request: HatRequest, context: HatContext) {
  await core(() =>
    context.app.speakers.forget(request.params.id, source(request, context))
  );
  return new Response(null, { status: 204 });
}
