import type { HatContext, HatRequest } from '#melofon/types.ts';
import { core } from '#melofon/errors.ts';

export default async function (request: HatRequest, context: HatContext) {
  const result = await core(() =>
    context.app.speakers.clearPassword(request.params.id)
  );
  return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
